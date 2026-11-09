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
 * Cuenta conectada del artista con Accounts v2 (Stripe ya no admite crearlas con la API v1 en
 * cuentas nuevas). Nuestro modelo cobra en la plataforma y transfiere despues (BR2-CB4), asi que la
 * cuenta es de tipo «recipient» con solo la capacidad `stripe_transfers`, y panel Express. Con panel
 * Express Stripe exige que la plataforma asuma comisiones y saldos negativos (`application`); es lo
 * mismo que ya ocurria con las cuentas Express de la API v1. Contrastado con el sandbox (spike).
 */
export const ACCOUNT_CREATION_PARAMS = {
  identity: { country: 'es' },
  dashboard: 'express',
  defaults: {
    currency: 'eur',
    responsibilities: { fees_collector: 'application', losses_collector: 'application' },
  },
  configuration: {
    recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
  },
} as const;

/** Campos que se piden al consultar la cuenta (la sintaxis `include[]` no la admite la API v2). */
const ACCOUNT_INCLUDES = ['configuration.recipient', 'requirements'] as const;

/** Tipos de evento que cambian el estado de cobros (eventos finos de cuentas v2). */
export const isAccountStateEvent = (type: string): boolean =>
  type === 'v2.core.account.closed' ||
  type === 'v2.core.account.updated' ||
  type.startsWith('v2.core.account[configuration.recipient]') ||
  type.startsWith('v2.core.account[requirements]');

/** Reduce una cuenta de Stripe al resumen que usa el dominio (sin datos personales). */
export const snapshotFromAccount = (
  account: Stripe.V2.Core.Account,
  eventAt: number,
): AccountSnapshot => {
  const balance = account.configuration?.recipient?.capabilities?.stripe_balance;
  const transfers = balance?.stripe_transfers?.status;
  const payouts = balance?.payouts?.status;
  // Hay datos por aportar mientras alguna exigencia espera al artista; si solo espera a Stripe, ya
  // se enviaron y falta la verificacion.
  const awaitingArtist = (account.requirements?.entries ?? []).some(
    (entry) => entry.awaiting_action_from === 'user',
  );
  return {
    detailsSubmitted: !awaitingArtist,
    transfersActive: transfers === 'active',
    payoutsEnabled: payouts === 'active',
    disabled: account.closed === true || transfers === 'rejected' || payouts === 'rejected',
    eventAt,
  };
};

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
      const account = await this.stripe.v2.core.accounts.create(
        {
          ...ACCOUNT_CREATION_PARAMS,
          contact_email: input.email,
          metadata: { artist_id: input.artistId },
        },
        // Determinista: reintentar la misma operacion no crea una segunda cuenta.
        { idempotencyKey: `create_account_v2:${input.artistId}` },
      );
      if (this.options.manualPayouts) {
        // U5: la plataforma transfiere al entregar y la artista retira con «Retirar». Si falla,
        // el reintento recrea (idempotente) la misma cuenta y vuelve a fijar el calendario.
        await this.setManualPayouts(account.id);
      }
      return ok({ providerAccountId: account.id });
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  /** Calendario de pagos manual de una cuenta (API de ajustes de saldo, con la cuenta como actor). */
  async setManualPayouts(providerAccountId: string): Promise<void> {
    await this.stripe.balanceSettings.update(
      { payments: { payouts: { schedule: { interval: 'manual' } } } },
      { stripeAccount: providerAccountId },
    );
  }

  async createOnboardingLink(
    providerAccountId: string,
    urls: { returnUrl: string; refreshUrl: string },
  ): Promise<Result<{ url: string }, AppError>> {
    try {
      const link = await this.stripe.v2.core.accountLinks.create({
        account: providerAccountId,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: { return_url: urls.returnUrl, refresh_url: urls.refreshUrl },
        },
      });
      return ok({ url: link.url });
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async getAccountSnapshot(providerAccountId: string): Promise<Result<AccountSnapshot, AppError>> {
    try {
      const account = await this.stripe.v2.core.accounts.retrieve(providerAccountId, {
        include: [...ACCOUNT_INCLUDES],
      });
      return ok(snapshotFromAccount(account, this.options.now()));
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  /**
   * Verifica la firma sobre el cuerpo crudo (SECURITY-13). Los eventos de cuenta v2 son finos: solo
   * identifican la cuenta, y el trabajo que los procesa consulta su estado.
   */
  parseEvent(rawBody: string, signature: string): Result<ConnectEvent | null, 'invalid_signature'> {
    let notification: Stripe.V2.Core.EventNotification;
    try {
      notification = this.stripe.parseEventNotification(
        rawBody,
        signature,
        this.options.connectWebhookSecret,
      );
    } catch {
      return err('invalid_signature');
    }
    if (!isAccountStateEvent(notification.type)) return ok(null);
    const related = 'related_object' in notification ? notification.related_object : null;
    const accountId = related && 'id' in related ? related.id : undefined;
    if (typeof accountId !== 'string' || !accountId.startsWith('acct_')) return ok(null);
    const created = Date.parse(notification.created);
    return ok({
      id: notification.id,
      type: notification.type,
      providerAccountId: accountId,
      occurredAt: Number.isNaN(created) ? this.options.now() : created,
    });
  }
}
