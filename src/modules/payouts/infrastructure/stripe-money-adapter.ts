import Stripe from 'stripe';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { MoneyProvider } from '../application/ports';

export type StripeMoneyOptions = {
  readonly secretKey: string;
  readonly apiVersion: string;
  /** `fetch` resiliente; el pago a banco usa su propio limite de tiempo (10 s). */
  readonly fetch: typeof fetch;
  readonly payoutFetch?: typeof fetch;
};

/** Conexion, 5xx y limite de tasa: resultado dudoso (reintentable). El resto es definitivo. */
const mapError = (cause: unknown): AppError => {
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

const IDEMPOTENCY_META = 'ml_key';

/**
 * Dinero con Stripe Connect: transferencias ligadas al cobro (`source_transaction`), pagos a
 * banco desde la cuenta de la artista y reembolsos parciales. Escrito contra la documentacion y
 * los tipos del SDK; su comprobacion real queda en el runbook y en el spike de U0 (P5 a P7).
 */
export class StripeMoneyAdapter implements MoneyProvider {
  private readonly stripe: Stripe;
  private readonly payoutStripe: Stripe;

  constructor(options: StripeMoneyOptions) {
    const build = (f: typeof fetch): Stripe =>
      new Stripe(options.secretKey, {
        apiVersion: options.apiVersion as Stripe.LatestApiVersion,
        httpClient: Stripe.createFetchHttpClient(f),
        maxNetworkRetries: 0,
        timeout: 10_000,
        appInfo: { name: 'marketlink' },
      });
    this.stripe = build(options.fetch);
    this.payoutStripe = build(options.payoutFetch ?? options.fetch);
  }

  async chargeOf(
    paymentIntentId: string,
  ): Promise<
    Result<{ chargeId: string; method: 'tarjeta' | 'bizum' | undefined } | undefined, AppError>
  > {
    try {
      const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge'],
      });
      const charge = pi.latest_charge;
      if (!charge) return ok(undefined);
      if (typeof charge === 'string') return ok({ chargeId: charge, method: undefined });
      const type = charge.payment_method_details?.type;
      return ok({
        chargeId: charge.id,
        method: type === 'card' ? 'tarjeta' : type === 'bizum' ? 'bizum' : undefined,
      });
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async transfer(input: {
    orderId: string;
    destinationAccountId: string;
    amountCents: number;
    chargeId: string;
    idempotencyKey: string;
  }): Promise<Result<{ transferRef: string }, AppError>> {
    try {
      const t = await this.stripe.transfers.create(
        {
          amount: input.amountCents,
          currency: 'eur',
          destination: input.destinationAccountId,
          source_transaction: input.chargeId,
          transfer_group: input.orderId,
          metadata: { order_id: input.orderId, [IDEMPOTENCY_META]: input.idempotencyKey },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return ok({ transferRef: t.id });
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async findTransfer(
    orderId: string,
  ): Promise<Result<{ transferRef: string } | undefined, AppError>> {
    try {
      const list = await this.stripe.transfers.list({ transfer_group: orderId, limit: 10 });
      const found = list.data.find((t) => !t.reversed && t.metadata?.order_id === orderId);
      return ok(found ? { transferRef: found.id } : undefined);
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async payout(input: {
    accountId: string;
    amountCents: number;
    idempotencyKey: string;
    timeoutMs: number;
  }): Promise<Result<{ payoutRef: string }, AppError>> {
    try {
      const p = await this.payoutStripe.payouts.create(
        {
          amount: input.amountCents,
          currency: 'eur',
          metadata: { [IDEMPOTENCY_META]: input.idempotencyKey },
        },
        {
          stripeAccount: input.accountId,
          idempotencyKey: input.idempotencyKey,
          timeout: input.timeoutMs,
        },
      );
      return ok({ payoutRef: p.id });
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async findPayout(
    accountId: string,
    idempotencyKey: string,
  ): Promise<Result<{ payoutRef: string } | undefined, AppError>> {
    try {
      const list = await this.payoutStripe.payouts.list(
        { limit: 20 },
        { stripeAccount: accountId },
      );
      const found = list.data.find((p) => p.metadata?.[IDEMPOTENCY_META] === idempotencyKey);
      return ok(found ? { payoutRef: found.id } : undefined);
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async refund(input: {
    paymentIntentId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<Result<{ refundRef: string }, AppError>> {
    try {
      const r = await this.stripe.refunds.create(
        {
          payment_intent: input.paymentIntentId,
          amount: input.amountCents,
          metadata: { [IDEMPOTENCY_META]: input.idempotencyKey },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return ok({ refundRef: r.id });
    } catch (cause) {
      return err(mapError(cause));
    }
  }
}
