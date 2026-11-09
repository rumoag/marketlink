import type { JobHandlerRegistry } from '@/modules/jobs/application/job-queue';
import { MAX_ATTEMPTS } from '@/modules/jobs/domain/job';
import type { DispatchNotifications } from '@/modules/notifications/application/dispatch';
import type { ProcessShipmentFact, PollShipments } from '@/modules/shipping/application/apply-fact';
import type { CreateShipmentDraft } from '@/modules/shipping/application/draft';
import type { PurgeLabelsAndNotifications } from '@/modules/shipping/application/documents';
import type { RemindPayLabel, RemindPickup } from '@/modules/shipping/application/reminders';
import {
  JOB_CREATE_SHIPMENT_DRAFT,
  JOB_DISPATCH_NOTIFICATIONS,
  JOB_POLL_SHIPMENTS,
  JOB_PROCESS_SHIPMENT_FACT,
  JOB_PURGE_LABELS,
  JOB_REMIND_PAY_LABEL,
  JOB_REMIND_PICKUP,
  parseFact,
} from './ingest-shipment-event';

export type U4JobDeps = {
  readonly draft: Pick<CreateShipmentDraft, 'execute'>;
  readonly processFact: Pick<ProcessShipmentFact, 'execute'>;
  readonly poll: Pick<PollShipments, 'execute'>;
  readonly dispatch: Pick<DispatchNotifications, 'execute'>;
  readonly remindPickup: Pick<RemindPickup, 'execute'>;
  readonly remindPay: Pick<RemindPayLabel, 'execute'>;
  readonly purge: Pick<PurgeLabelsAndNotifications, 'execute'>;
  readonly markProcessed: (eventId: string) => Promise<void>;
};

const retry = (message: string) => ({ ok: false as const, error: { retryable: true, message } });

/** Registra los trabajos de U4 en el registro de la cola de U1. Todos son idempotentes. */
export const registerU4Jobs = (registry: JobHandlerRegistry, deps: U4JobDeps): void => {
  registry.register(JOB_CREATE_SHIPMENT_DRAFT, async (job, ctx) => {
    const orderId = job.payload.orderId;
    if (typeof orderId !== 'string') {
      return { ok: false, error: { retryable: false, message: 'invalid_draft_payload' } };
    }
    const r = await deps.draft.execute(orderId, ctx.correlationId, job.attempts >= MAX_ATTEMPTS);
    return r.ok ? { ok: true } : retry('create_draft_failed');
  });

  registry.register(JOB_PROCESS_SHIPMENT_FACT, async (job, ctx) => {
    const fact = parseFact(job.payload.fact);
    const ref = job.payload.providerRef;
    const eventId = job.payload.eventId;
    if (!fact || typeof ref !== 'string' || typeof eventId !== 'string') {
      return { ok: false, error: { retryable: false, message: 'invalid_fact_payload' } };
    }
    const r = await deps.processFact.execute(
      ref,
      fact,
      ctx.correlationId,
      job.attempts >= MAX_ATTEMPTS,
    );
    if (!r.ok) return retry('process_fact_failed');
    await deps.markProcessed(eventId);
    return { ok: true };
  });

  registry.register(JOB_POLL_SHIPMENTS, async (_job, ctx) => {
    await deps.poll.execute(ctx.correlationId);
    return { ok: true };
  });
  registry.register(JOB_DISPATCH_NOTIFICATIONS, async (_job, ctx) => {
    await deps.dispatch.execute(ctx.correlationId);
    return { ok: true };
  });
  registry.register(JOB_REMIND_PICKUP, async (_job, ctx) => {
    await deps.remindPickup.execute(ctx.correlationId);
    return { ok: true };
  });
  registry.register(JOB_REMIND_PAY_LABEL, async (_job, ctx) => {
    await deps.remindPay.execute(ctx.correlationId);
    return { ok: true };
  });
  registry.register(JOB_PURGE_LABELS, async (_job, ctx) => {
    await deps.purge.execute(ctx.correlationId);
    return { ok: true };
  });
};
