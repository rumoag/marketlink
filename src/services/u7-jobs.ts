import type { JobHandlerRegistry } from '@/modules/jobs/application/job-queue';
import {
  JOB_PURGE_PERSONAL_DATA,
  JOB_SECURITY_ALERTS,
  type SecurityAlerts,
} from '@/modules/operator/application/monitoring';
import type { PurgePersonalData } from '@/modules/operator/application/privacy';

export type U7JobDeps = {
  readonly purge: Pick<PurgePersonalData, 'runBatch'>;
  readonly security: Pick<SecurityAlerts, 'execute'>;
};

/** Registra los trabajos de U7. Ambos son idempotentes. */
export const registerU7Jobs = (registry: JobHandlerRegistry, deps: U7JobDeps): void => {
  registry.register(JOB_PURGE_PERSONAL_DATA, async (_job, ctx) => {
    const r = await deps.purge.runBatch(ctx.correlationId);
    // Un pedido que falla se reintenta al dia siguiente; el trabajo en si no es un fallo.
    return r.failed > 0 && r.purged === 0
      ? { ok: false, error: { retryable: true, message: 'purge_personal_data_failed' } }
      : { ok: true };
  });
  registry.register(JOB_SECURITY_ALERTS, async (_job, ctx) => {
    await deps.security.execute(ctx.correlationId);
    return { ok: true };
  });
};
