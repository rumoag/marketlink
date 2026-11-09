import type { AppConfig } from '@/modules/platform/application/config';
import type { Logger } from '@/modules/platform/application/ports';

/**
 * Disparo inmediato del procesamiento tras encolar (P-RES-3). Llama al endpoint interno con el
 * secreto compartido. Si falla no pasa nada: pg_cron procesa la cola cada minuto.
 * Los llamadores deben invocarlo con `after()` de Next.js para que no bloquee la respuesta.
 */
export const triggerJobRun = async (config: AppConfig, logger: Logger): Promise<void> => {
  try {
    const res = await fetch(`${config.appUrl}/api/internal/jobs/run`, {
      method: 'POST',
      headers: { 'x-internal-secret': config.internalJobsSecret.reveal() },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) logger.warn('job_trigger_rejected', { status: res.status });
  } catch {
    logger.warn('job_trigger_failed');
  }
};
