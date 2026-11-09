import { describe, expect, it } from 'vitest';
import { MS } from '@/modules/kernel/domain/clock';
import { JobHandlerRegistry, JobQueue, sanitizeError } from '@/modules/jobs/application/job-queue';
import { LEASE_MS, RETRY_WAITS_MS } from '@/modules/jobs/domain/job';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { LoggingOperatorNotifier } from '@/modules/platform/application/operator-notifier';
import { createRegistry, JOB_TYPES } from '@/modules/jobs/infrastructure/handlers';
import { FakeClock } from '@tests/support/generators';
import { MemoryAuditStore, MemoryLogger } from '@tests/support/fakes';
import { MemoryJobStore } from '@tests/support/memory-job-store';

const build = () => {
  const clock = new FakeClock(Date.UTC(2026, 10, 4, 10, 0, 0));
  const store = new MemoryJobStore();
  const logger = new MemoryLogger();
  const auditStore = new MemoryAuditStore();
  const registry = new JobHandlerRegistry();
  const queue = new JobQueue({
    store,
    registry,
    clock,
    logger,
    audit: new AuditLog(auditStore, logger, clock),
    notifier: new LoggingOperatorNotifier(logger),
  });
  return { clock, store, logger, auditStore, registry, queue };
};

describe('JobQueue (ejemplos)', () => {
  it('esperas exactas 1 min, 5 min, 30 min, 2 h y 12 h para los intentos 1 a 5', async () => {
    const { clock, store, registry, queue } = build();
    registry.register('x', () =>
      Promise.resolve({ ok: false, error: { retryable: true, message: 'nope' } }),
    );
    const job = await queue.enqueue({ type: 'x' });

    const expected = [MS.minute, 5 * MS.minute, 30 * MS.minute, 2 * MS.hour, 12 * MS.hour];
    expect(RETRY_WAITS_MS).toEqual(expected);
    for (let i = 0; i < expected.length; i++) {
      const before = clock.now();
      await queue.runBatch({ correlationId: 'c' });
      const current = store.jobs.get(job.id);
      expect(current?.status).toBe('pending');
      expect(current?.attempts).toBe(i + 1);
      expect((current?.runAt ?? 0) - before).toBe(expected[i]);
      clock.advance(expected[i] ?? 0);
    }
  });

  it('el sexto fallo reintentable termina en failed, con AuditEvent y alerta (BR-J2)', async () => {
    const { clock, store, registry, queue, auditStore, logger } = build();
    registry.register('x', () =>
      Promise.resolve({ ok: false, error: { retryable: true, message: 'nope' } }),
    );
    const job = await queue.enqueue({ type: 'x' });
    for (let i = 0; i < 6; i++) {
      await queue.runBatch({ correlationId: 'c' });
      clock.advance(13 * MS.hour);
    }
    expect(store.jobs.get(job.id)?.status).toBe('failed');
    expect(store.jobs.get(job.id)?.attempts).toBe(6);
    expect(auditStore.events.map((e) => e.action)).toEqual(['job_failed']);
    expect(logger.entries.some((e) => e.message === 'operator_alert' && e.level === 'error')).toBe(
      true,
    );
    // Un trabajo terminal no se vuelve a ejecutar.
    const summary = await queue.runBatch({ correlationId: 'c' });
    expect(summary.claimed).toBe(0);
  });

  it('un error permanente va a failed de inmediato (BR-J3)', async () => {
    const { store, registry, queue } = build();
    registry.register('x', () =>
      Promise.resolve({ ok: false, error: { retryable: false, message: 'definitivo' } }),
    );
    const job = await queue.enqueue({ type: 'x' });
    await queue.runBatch({ correlationId: 'c' });
    expect(store.jobs.get(job.id)?.status).toBe('failed');
    expect(store.jobs.get(job.id)?.attempts).toBe(1);
  });

  it('un tipo sin manejador pasa a failed de inmediato (BR-J4)', async () => {
    const { store, queue } = build();
    const job = await queue.enqueue({ type: 'desconocido' });
    await queue.runBatch({ correlationId: 'c' });
    expect(store.jobs.get(job.id)?.status).toBe('failed');
    expect(store.jobs.get(job.id)?.lastError).toBe('handler_not_found');
  });

  it('una excepcion en el manejador se reintenta sin filtrar su mensaje', async () => {
    const { store, registry, queue } = build();
    registry.register('x', () => Promise.reject(new Error('password=hunter2')));
    const job = await queue.enqueue({ type: 'x' });
    await queue.runBatch({ correlationId: 'c' });
    const current = store.jobs.get(job.id);
    expect(current?.status).toBe('pending');
    expect(JSON.stringify(current)).not.toContain('hunter2');
  });

  it('un bloqueo vencido devuelve el trabajo a pending consumiendo el intento (BR-J6)', async () => {
    const { clock, store, queue, registry } = build();
    registry.register('x', () => Promise.resolve({ ok: true }));
    const job = await queue.enqueue({ type: 'x' });
    await store.claim(clock.now(), 1, LEASE_MS); // un proceso reclama y muere
    expect(store.jobs.get(job.id)?.status).toBe('running');
    clock.advance(LEASE_MS - 1);
    await queue.runBatch({ correlationId: 'c' });
    expect(store.jobs.get(job.id)?.status).toBe('running'); // aun dentro del bloqueo
    clock.advance(1);
    const summary = await queue.runBatch({ correlationId: 'c' });
    expect(summary.recovered).toBe(1);
    expect(store.jobs.get(job.id)?.status).toBe('pending');
    expect(store.jobs.get(job.id)?.attempts).toBe(1);
  });

  it('dedupeKey: encolar con la clave de un trabajo no terminal devuelve el mismo (BR-J7)', async () => {
    const { queue, registry, store } = build();
    registry.register('x', () => Promise.resolve({ ok: true }));
    const a = await queue.enqueue({ type: 'x', dedupeKey: 'k' });
    const b = await queue.enqueue({ type: 'x', dedupeKey: 'k' });
    expect(b.id).toBe(a.id);
    await queue.runBatch({ correlationId: 'c' }); // a termina
    const c = await queue.enqueue({ type: 'x', dedupeKey: 'k' });
    expect(c.id).not.toBe(a.id);
    expect(store.jobs.size).toBe(2);
  });

  it('respeta runAt: no se reclama antes de su hora', async () => {
    const { clock, queue, registry } = build();
    registry.register('x', () => Promise.resolve({ ok: true }));
    await queue.enqueue({ type: 'x', runAt: (clock.now() + MS.hour) as never });
    expect((await queue.runBatch({ correlationId: 'c' })).claimed).toBe(0);
    clock.advance(MS.hour);
    expect((await queue.runBatch({ correlationId: 'c' })).succeeded).toBe(1);
  });

  it('sanitizeError redacta datos personales y acota la longitud (BR-J9)', () => {
    expect(sanitizeError('fallo con ana@example.com')).not.toContain('example.com');
    expect(sanitizeError('x'.repeat(2000)).length).toBeLessThanOrEqual(500);
  });
});

describe('Registro de manejadores de plataforma', () => {
  it('el trabajo de limpieza borra ventanas antiguas y reintenta si falla', async () => {
    const calls: unknown[][] = [];
    const registry = createRegistry({
      query: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ rows: [] } as never);
      },
    });
    const handler = registry.get(JOB_TYPES.cleanupRateLimitCounters);
    expect(handler).toBeDefined();
    const ctx = { correlationId: 'c', logger: new MemoryLogger() };
    const job = { id: '1' } as never;
    expect(await handler?.(job, ctx)).toEqual({ ok: true });
    expect(String(calls[0]?.[0])).toContain('DELETE FROM rate_limit_counters');

    const failing = createRegistry({ query: () => Promise.reject(new Error('db')) });
    expect(await failing.get(JOB_TYPES.cleanupRateLimitCounters)?.(job, ctx)).toEqual({
      ok: false,
      error: { retryable: true, message: 'cleanup_failed' },
    });
  });
});
