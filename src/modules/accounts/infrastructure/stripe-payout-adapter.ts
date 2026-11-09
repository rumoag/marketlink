import Stripe from 'stripe';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Email } from '@/modules/kernel/domain/formats';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { ConnectEvent, PayoutProvider } from '../application/ports';
import type { AccountSnapshot } from '../domain/payout';

export type StripePayoutOptions = {
  readonly secretKey: string;
  /** Version de la API fijada por configuracion (cambios de version se revisan a mano). */
  readonly apiVersion: string;
  readonly connectWebhookSecret: string;
  /** `fetch` resiliente (tiempo de espera, circuito, reintentos solo con clave de idempotencia). */
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** U5: con retirada manual las cuentas nuevas se crean con calendario de pagos manual. */
  readonly manualPayouts?: boolean;
};

/**
 * Capacidades solicitadas a la cuenta del artista. Nuestro modelo cobra en la plataforma y
 * transfiere despues, asi que solo hace falta `transfers` (BR2-CB4). PENDIENTE DE CONTRASTAR con el
 * spike de U0: si Stripe exige `card_payments` para cuentas Express nacionales, se anade aqui.
 */
export const REQUESTED_CAPABILITIES = { transfers: { requested: true } } as const;

/** Reduce una cuenta de Stripe al resumen que usa el dominio (sin datos personales). */
export const snapshotFromAccount = (account: Stripe.Account, eventAt: number): AccountSnapshot => ({
  detailsSubmitted: account.details_submitted === true,
  transfersActive: account.capabilities?.transfers === 'active',
  payoutsEnabled: account.payouts_enabled === true,
  disabled: Boolean(account.requirements?.disabled_reason),
  eventAt,
});

const mapError = (cause: unknown): AppError => {
  // Un error de conexion o del servicio de Stripe se puede reintentar; el resto es interno.
  if (
    cause instanceof Stripe.errors.StripeConnectionError ||
    cause instanceof Stripe.errors.StripeAPIError ||
    cause instanceof Stripe.errors.StripeRateLimitError ||
    (cause instanceof TypeError && cause.message === 'dependency_unavailable')
  ) {
    return appError('dependency_unavailable');
  }
  return appError('internal');
};

export class StripePayoutAdapter implements PayoutProvider {
  private readonly stripe: Stripe;

  constructor(private readonly options: StripePayoutOptions) {
    this.stripe = new Stripe(options.secretKey, {
      apiVersion: options.apiVersion as Stripe.LatestApiVersion,
      httpClient: Stripe.createFetchHttpClient(options.fetch),
      // Los reintentos los gestiona el cliente resiliente (solo con clave de idempotencia).
      maxNetworkRetries: 0,
      timeout: 10_000,
      appInfo: { name: 'marketlink' },
    });
  }

  async createAccount(input: {
    artistId: string;
    email: Email;
  }): Promise<Result<{ providerAccountId: string }, AppError>> {
    try {
      const account = await this.stripe.accounts.create(
        {
          type: 'express',
          country: 'ES',
          email: input.email,
          capabilities: REQUESTED_CAPABILITIES,
          ...(this.options.manualPayouts
            ? { settings: { payouts: { schedule: { interval: 'manual' as const } } } }
            : {}),
          metadata: { artist_id: input.artistId },
        },
        // Determinista: reintentar la misma operacion no crea una segunda cuenta.
        { idempotencyKey: `create_account:${input.artistId}` },
      );
      return ok({ providerAccountId: account.id });
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async createOnboardingLink(
    providerAccountId: string,
    urls: { returnUrl: string; refreshUrl: string },
  ): Promise<Result<{ url: string }, AppError>> {
    try {
      const link = await this.stripe.accountLinks.create({
        account: providerAccountId,
        type: 'account_onboarding',
        return_url: urls.returnUrl,
        refresh_url: urls.refreshUrl,
      });
      return ok({ url: link.url });
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async getAccountSnapshot(providerAccountId: string): Promise<Result<AccountSnapshot, AppError>> {
    try {
      const account = await this.stripe.accounts.retrieve(providerAccountId);
      return ok(snapshotFromAccount(account, this.options.now()));
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  /** Verifica la firma sobre el cuerpo crudo (SECURITY-13) y reduce el evento. */
  parseEvent(rawBody: string, signature: string): Result<ConnectEvent | null, 'invalid_signature'> {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.options.connectWebhookSecret,
      );
    } catch {
      return err('invalid_signature');
    }
    if (event.type !== 'account.updated') return ok(null);
    const account = event.data.object;
    return ok({
      id: event.id,
      type: event.type,
      providerAccountId: account.id,
      snapshot: snapshotFromAccount(account, event.created * 1000),
    });
  }
}
