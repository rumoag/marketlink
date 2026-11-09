import Stripe from 'stripe';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Instant } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type {
  CheckoutSession,
  CreateSessionInput,
  PaidSession,
  PaymentEvent,
  PaymentProvider,
} from '../application/ports';

export type StripePaymentOptions = {
  readonly secretKey: string;
  readonly apiVersion: string;
  /** Secreto del webhook de la plataforma (no el de cuentas conectadas). */
  readonly platformWebhookSecret: string;
  /** `fetch` resiliente (tiempo de espera, circuito, reintentos solo con clave de idempotencia). */
  readonly fetch: typeof fetch;
};

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

const paymentIntentId = (s: Stripe.Checkout.Session): string | undefined =>
  typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? undefined);

/** Reduce la sesion de Stripe a lo que usa el dominio (sin datos personales). */
export const toCheckoutSession = (s: Stripe.Checkout.Session): CheckoutSession => ({
  id: s.id,
  url: s.url ?? undefined,
  status: s.status === 'complete' ? 'completada' : s.status === 'expired' ? 'expirada' : 'abierta',
  paid: s.payment_status === 'paid',
  paymentIntentId: paymentIntentId(s),
  orderId: s.client_reference_id ?? s.metadata?.order_id ?? undefined,
  amountCents: s.amount_total ?? undefined,
});

const HANDLED = {
  'checkout.session.completed': 'completed',
  'checkout.session.expired': 'expired',
  'checkout.session.async_payment_succeeded': 'async_succeeded',
  'checkout.session.async_payment_failed': 'async_failed',
} as const;

export class StripePaymentAdapter implements PaymentProvider {
  private readonly stripe: Stripe;

  constructor(private readonly options: StripePaymentOptions) {
    this.stripe = new Stripe(options.secretKey, {
      apiVersion: options.apiVersion as Stripe.LatestApiVersion,
      httpClient: Stripe.createFetchHttpClient(options.fetch),
      maxNetworkRetries: 0, // los reintentos los gestiona el cliente resiliente
      timeout: 10_000,
      appInfo: { name: 'marketlink' },
    });
  }

  async createCheckoutSession(
    input: CreateSessionInput,
  ): Promise<Result<CheckoutSession, AppError>> {
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          client_reference_id: input.orderId,
          customer_email: input.customerEmail,
          // Nombres de linea genericos; el importe lo calcula siempre el servidor (BR3-PG1, PG3).
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: 'eur',
                unit_amount: input.workPriceCents,
                product_data: { name: `Obra: ${input.workTitle}`.slice(0, 120) },
              },
            },
            {
              quantity: 1,
              price_data: {
                currency: 'eur',
                unit_amount: input.shippingCents,
                product_data: { name: 'Envío' },
              },
            },
          ],
          // Filtro de metodos: tarjeta siempre; Bizum solo con el flag (BR3-PG2).
          allowed_payment_method_types: [...input.methods],
          expires_at: Math.floor(input.expiresAt / 1000),
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          // Solo el id del pedido viaja a Stripe como referencia (sin datos personales).
          metadata: { order_id: input.orderId },
          payment_intent_data: { metadata: { order_id: input.orderId } },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return ok(toCheckoutSession(session));
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async expireSession(sessionId: string): Promise<Result<CheckoutSession, AppError>> {
    try {
      return ok(toCheckoutSession(await this.stripe.checkout.sessions.expire(sessionId)));
    } catch (cause) {
      // Una sesion ya completada o caducada no se puede caducar: se devuelve su estado real.
      if (cause instanceof Stripe.errors.StripeInvalidRequestError) {
        return this.getSession(sessionId);
      }
      return err(mapError(cause));
    }
  }

  async getSession(sessionId: string): Promise<Result<CheckoutSession, AppError>> {
    try {
      return ok(toCheckoutSession(await this.stripe.checkout.sessions.retrieve(sessionId)));
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async listPaidSessions(since: Instant): Promise<Result<PaidSession[], AppError>> {
    try {
      const sessions = await this.stripe.checkout.sessions
        .list({ created: { gte: Math.floor(since / 1000) }, limit: 100 })
        .autoPagingToArray({ limit: 500 });
      return ok(
        sessions
          .filter((s) => s.payment_status === 'paid')
          .map((s) => ({
            sessionId: s.id,
            orderId: s.client_reference_id ?? s.metadata?.order_id ?? undefined,
            paymentIntentId: paymentIntentId(s),
            amountCents: s.amount_total ?? 0,
          })),
      );
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async refund(input: {
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<Result<{ refundId: string }, AppError>> {
    try {
      // Si ya existe un reembolso de este pago no se crea otro (BR de reembolso idempotente).
      const existing = await this.stripe.refunds.list({
        payment_intent: input.paymentIntentId,
        limit: 1,
      });
      const first = existing.data[0];
      if (first) return ok({ refundId: first.id });
      const refund = await this.stripe.refunds.create(
        { payment_intent: input.paymentIntentId, reason: 'duplicate' },
        { idempotencyKey: input.idempotencyKey },
      );
      return ok({ refundId: refund.id });
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  /** Verifica la firma sobre el cuerpo crudo (SECURITY-13) y reduce el evento. */
  parseEvent(rawBody: string, signature: string): Result<PaymentEvent | null, 'invalid_signature'> {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.options.platformWebhookSecret,
      );
    } catch {
      return err('invalid_signature');
    }
    // U5: eventos del cobro (solo conciliacion).
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const obj = event.data.object as Stripe.Charge | Stripe.Dispute;
      const pi = obj.payment_intent;
      return ok({
        id: event.id,
        type: event.type === 'charge.refunded' ? 'charge_refunded' : 'dispute_created',
        sessionId: '',
        orderId: undefined,
        paymentIntentId: typeof pi === 'string' ? pi : (pi?.id ?? undefined),
        paid: false,
        amountCents:
          event.type === 'charge.refunded'
            ? (obj as Stripe.Charge).amount_refunded
            : (obj as Stripe.Dispute).amount,
      });
    }
    const type = (HANDLED as Record<string, PaymentEvent['type'] | undefined>)[event.type];
    if (type === undefined) return ok(null);
    const session = event.data.object as Stripe.Checkout.Session;
    const reduced = toCheckoutSession(session);
    return ok({
      id: event.id,
      type,
      sessionId: session.id,
      orderId: reduced.orderId,
      paymentIntentId: reduced.paymentIntentId,
      paid: reduced.paid,
      amountCents: reduced.amountCents,
    });
  }
}
