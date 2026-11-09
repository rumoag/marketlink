import type { PhotoService } from '@/modules/listings/application/photo-service';
import type { JobHandlerRegistry } from '@/modules/jobs/application/job-queue';
import type { OperatorNotifier } from '@/modules/platform/application/operator-notifier';
import type { Logger } from '@/modules/platform/application/ports';
import type { ApplyAccountEventUseCase } from './apply-account-event';
import { JOB_APPLY_ACCOUNT_EVENT, parsePayload, type JobEnqueuer } from './ingest-account-event';

export const JOB_NOTIFY_PAYOUT_RESTRICTED = 'notify_payout_restricted';
export const JOB_CLEANUP_ORPHAN_UPLOADS = 'cleanup_orphan_uploads';

export type U2JobDeps = {
  readonly apply: Pick<ApplyAccountEventUseCase, 'applyByProviderAccount'>;
  readonly photos: Pick<PhotoService, 'cleanupExpiredUploads'>;
  readonly enqueue: JobEnqueuer;
  readonly notifier: OperatorNotifier;
  readonly markProcessed: (eventId: string) => Promise<void>;
  readonly logger: Logger;
};

/** Registra los trabajos de U2 en el registro de la cola de U1. */
export const registerU2Jobs = (registry: JobHandlerRegistry, deps: U2JobDeps): void => {
  // P2-WH-1: aplica el evento guardado. Idempotente: repetirlo no cambia nada.
  registry.register(JOB_APPLY_ACCOUNT_EVENT, async (job) => {
    const payload = parsePayload(job.payload);
    const eventId = typeof job.payload.eventId === 'string' ? job.payload.eventId : undefined;
    if (!payload || !eventId) {
      return { ok: false, error: { retryable: false, message: 'invalid_event_payload' } };
    }
    const applied = await deps.apply.applyByProviderAccount(
      payload.providerAccountId,
      payload.snapshot,
    );
    if (!applied.ok) {
      return { ok: false, error: { retryable: true, message: 'apply_account_event_failed' } };
    }
    const result = applied.value;
    if (result?.applied && result.becameRestricted) {
      await deps.enqueue({
        type: JOB_NOTIFY_PAYOUT_RESTRICTED,
        payload: { artistId: result.artistId, pausedListings: result.pausedListings },
        dedupeKey: `payout-restricted:${result.artistId}:${payload.snapshot.eventAt}`,
      });
    }
    await deps.markProcessed(eventId);
    return { ok: true };
  });

  // Aviso al operador (U7 anade el correo; el aviso al artista es su panel, que refleja el estado).
  registry.register(JOB_NOTIFY_PAYOUT_RESTRICTED, async (job) => {
    await deps.notifier.notify({
      severity: 'warning',
      title: 'Cobros restringidos: enlaces pausados',
      details: { artistId: job.payload.artistId, pausedListings: job.payload.pausedListings },
    });
    return { ok: true };
  });

  // Limpieza diaria de subidas pendientes caducadas y sus objetos (P2-FOT-1).
  registry.register(JOB_CLEANUP_ORPHAN_UPLOADS, async () => {
    const cleaned = await deps.photos.cleanupExpiredUploads();
    if (!cleaned.ok) {
      return { ok: false, error: { retryable: true, message: 'cleanup_uploads_failed' } };
    }
    deps.logger.info('orphan_uploads_cleaned', { removed: cleaned.value.removed });
    return { ok: true };
  });
};
