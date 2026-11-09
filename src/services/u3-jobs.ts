import type { JobHandlerRegistry } from '@/modules/jobs/application/job-queue';
import { MAX_ATTEMPTS } from '@/modules/jobs/domain/job';
import type {
  ExpireStaleOrders,
  PurgeUnpaidOrders,
  ReconcileStripe,
} from '@/modules/orders/application/maintenance';
import {
  factFromEvent,
  type ProcessPaymentFact,
} from '@/modules/orders/application/process-payment-event';
import type { RefundPayment } from '@/modules/orders/application/refund-payment';
import type { Logger } from '@/modules/platform/application/ports';
import type { JobEnqueuer } from './ingest-account-event';
import {
  JOB_EXPIRE_STALE_ORDERS,
  JOB_PROCESS_STRIPE_EVENT,
  JOB_PURGE_UNPAID_ORDERS,
  JOB_RECONCILE_STRIPE,
  JOB_REFUND_PAYMENT,
  parsePaymentEvent,
} from './ingest-payment-event';

export type U3JobDeps = {
  /** U5: eventos del cobro (reembolsos externos y disputas); solo avisan. */
  readonly chargeEvent?: (event: unknown, correlationId: string) => Promise<void>;
  readonly processor: Pick<ProcessPaymentFact, 'execute'>;
  readonly refund: Pick<RefundPayment, 'execute'>;
  readonly expire: Pick<ExpireStaleOrders, 'execute'>;
  readonly reconcile: Pick<ReconcileStripe, 'execute'>;
  readonly purge: Pick<PurgeUnpaidOrders, 'execute'>;
  readonly enqueue: JobEnqueuer;
  readonly markProcessed: (eventId: string) => Promise<void>;
  readonly logger: Logger;
};

/** Registra los trabajos de U3 en el registro de la cola de U1. Todos son idempotentes. */
export const registerU3Jobs = (registry: JobHandlerRegistry, deps: U3JobDeps): void => {
  registry.register(JOB_PROCESS_STRIPE_EVENT, async (job, ctx) => {
    const event = parsePaymentEvent(job.payload.event);
    if (!event) return { ok: false, error: { retryable: false, message: 'invalid_event_payload' } };
    if (event.type === 'charge_refunded' || event.type === 'dispute_created') {
      await deps.chargeEvent?.(job.payload.event, ctx.correlationId);
    }
    const fact = factFromEvent(event);
    if (fact) {
      const outcome = await deps.processor.execute(fact, ctx.correlationId);
      if (outcome.kind === 'applied' && outcome.needsRefund) {
        await deps.enqueue({
          type: JOB_REFUND_PAYMENT,
          payload: { orderId: outcome.orderId },
          dedupeKey: `refund:${outcome.orderId}`,
        });
      }
    }
    await deps.markProcessed(event.id);
    return { ok: true };
  });

  registry.register(JOB_REFUND_PAYMENT, async (job, ctx) => {
    const orderId = job.payload.orderId;
    if (typeof orderId !== 'string') {
      return { ok: false, error: { retryable: false, message: 'invalid_refund_payload' } };
    }
    const result = await deps.refund.execute(
      orderId,
      ctx.correlationId,
      job.attempts >= MAX_ATTEMPTS,
    );
    return result.ok
      ? { ok: true }
      : { ok: false, error: { retryable: true, message: 'refund_failed' } };
  });

  registry.register(JOB_EXPIRE_STALE_ORDERS, async (_job, ctx) => {
    await deps.expire.execute(ctx.correlationId);
    return { ok: true };
  });

  registry.register(JOB_RECONCILE_STRIPE, async (_job, ctx) => {
    const result = await deps.reconcile.execute(ctx.correlationId);
    return result.error
      ? { ok: false, error: { retryable: true, message: 'reconcile_failed' } }
      : { ok: true };
  });

  registry.register(JOB_PURGE_UNPAID_ORDERS, async (_job, ctx) => {
    const { purged } = await deps.purge.execute(ctx.correlationId);
    deps.logger.info('unpaid_orders_purged', { purged });
    return { ok: true };
  });
};
