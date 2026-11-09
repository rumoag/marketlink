import type { PaymentEvent, PaymentProvider } from '@/modules/orders/application/ports';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { Logger } from '@/modules/platform/application/ports';
import type { IngestResult, JobEnqueuer, WebhookEventStore } from './ingest-account-event';

export const JOB_PROCESS_STRIPE_EVENT = 'process_stripe_event';
export const JOB_REFUND_PAYMENT = 'refund_payment';
export const JOB_EXPIRE_STALE_ORDERS = 'expire_stale_orders';
export const JOB_RECONCILE_STRIPE = 'reconcile_stripe';
export const JOB_PURGE_UNPAID_ORDERS = 'purge_unpaid_orders';

const EVENT_TYPES: readonly string[] = [
  'completed',
  'expired',
  'async_succeeded',
  'async_failed',
  'charge_refunded',
  'dispute_created',
];

/** Lectura defensiva del evento guardado (viene de la base de datos). */
export const parsePaymentEvent = (raw: unknown): PaymentEvent | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  if (
    typeof e.id !== 'string' ||
    typeof e.type !== 'string' ||
    !EVENT_TYPES.includes(e.type) ||
    typeof e.sessionId !== 'string' ||
    typeof e.paid !== 'boolean'
  ) {
    return undefined;
  }
  return {
    id: e.id,
    type: e.type as PaymentEvent['type'],
    sessionId: e.sessionId,
    orderId: typeof e.orderId === 'string' ? e.orderId : undefined,
    paymentIntentId: typeof e.paymentIntentId === 'string' ? e.paymentIntentId : undefined,
    paid: e.paid,
    amountCents: typeof e.amountCents === 'number' ? e.amountCents : undefined,
  };
};

/**
 * Webhook de la plataforma de Stripe (BR3-WH1): verificar firma, guardar (idempotente), encolar y
 * confirmar. El procesado real ocurre en el trabajo. El evento guardado no tiene datos personales.
 */
export class IngestPaymentEvent {
  constructor(
    private readonly deps: {
      readonly provider: Pick<PaymentProvider, 'parseEvent'>;
      readonly store: WebhookEventStore;
      readonly enqueue: JobEnqueuer;
      readonly audit: AuditLog;
      readonly logger: Logger;
    },
  ) {}

  async handle(rawBody: string, signature: string, correlationId: string): Promise<IngestResult> {
    const parsed = this.deps.provider.parseEvent(rawBody, signature);
    if (!parsed.ok) {
      await this.deps.audit.record({
        actorType: 'anonymous',
        action: 'webhook_signature_invalid',
        resourceType: 'webhook',
        resourceId: 'stripe-platform',
        outcome: 'denied',
        correlationId,
      });
      return 'invalid_signature';
    }
    if (parsed.value === null) return 'ignored';
    const event = parsed.value;
    const isNew = await this.deps.store.insertIfNew('stripe', event.id, event.type, event);
    if (!isNew) return 'duplicate';
    await this.deps.enqueue({
      type: JOB_PROCESS_STRIPE_EVENT,
      payload: { eventId: event.id, event },
      dedupeKey: `stripe-event:${event.id}`,
    });
    this.deps.logger.info('payment_event_accepted', { eventType: event.type, correlationId });
    return 'accepted';
  }
}
