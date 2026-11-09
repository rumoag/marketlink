import { MS } from '@/modules/kernel/domain/clock';
import type { Db } from '@/modules/platform/infrastructure/db-client';
import { JobHandlerRegistry } from '../application/job-queue';

/** Tipos de trabajo de plataforma. Cada unidad registra los suyos en el mismo registro. */
export const JOB_TYPES = {
  cleanupRateLimitCounters: 'cleanup_rate_limit_counters',
} as const;

/** Las ventanas de contadores con mas de 48 h ya no se consultan (P-ESC-1). */
const COUNTER_RETENTION_MS = 48 * MS.hour;

export const createRegistry = (db: Pick<Db, 'query'>): JobHandlerRegistry => {
  const registry = new JobHandlerRegistry();

  registry.register(JOB_TYPES.cleanupRateLimitCounters, async () => {
    try {
      await db.query('DELETE FROM rate_limit_counters WHERE window_start < $1', [
        new Date(Date.now() - COUNTER_RETENTION_MS),
      ]);
      return { ok: true };
    } catch {
      return { ok: false, error: { retryable: true, message: 'cleanup_failed' } };
    }
  });

  return registry;
};
