import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MS, instantOf } from '@/modules/kernel/domain/clock';
import {
  JobHandlerRegistry,
  JobQueue,
  type JobHandler,
} from '@/modules/jobs/application/job-queue';
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  RETRY_WAITS_MS,
  isTerminal,
  resolveOutcome,
  retryWaitMs,
} from '@/modules/jobs/domain/job';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { LoggingOperatorNotifier } from '@/modules/platform/application/operator-notifier';
import { FakeClock } from '@tests/support/generators';
import { MemoryAuditStore, MemoryLogger } from '@tests/support/fakes';
import { MemoryJobStore } from '@tests/support/memory-job-store';

describe('P-U1-10 esquema de reintentos', () => {
  it('la espera para el intento n es [1 min, 5 min, 30 min, 2 h, 12 h][n-1], no decreciente y <= 12 h', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (n) => {
        expect(retryWaitMs(n)).toBe(RETRY_WAITS_MS[n - 1]);
        expect(retryWaitMs(n)).toBeLessThanOrEqual(12 * MS.hour);
        if (n > 1)
          expect(retryWaitMs(n) ?? 0).toBeGreaterThanOrEqual(retryWaitMs(n - 1) ?? Infinity);
      }),
    );
  });

  it('no hay espera fuera de 1..5 y un error reintentable al sexto intento termina en failed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 6, max: 1000 }),
        fc.integer({ min: -1000, max: 0 }),
        (hi, lo) => {
          expect(retryWaitMs(hi)).toBeUndefined();
          expect(retryWaitMs(lo)).toBeUndefined();
        },
      ),
    );
    const r = resolveOutcome(
      { attempts: MAX_ATTEMPTS },
      { ok: false, error: { retryable: true, message: 'x' } },
      instantOf(0),
    );
    expect(r.kind).toBe('failed');
  });

  it('resolveOutcome programa runAt = ahora + espera para cada intento reintentable', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 1e12 }),
        (attempts, t) => {
          const r = resolveOutcome(
            { attempts },
            { ok: false, error: { retryable: true, message: 'x' } },
            instantOf(t),
          );
          expect(r.kind).toBe('retry');
          if (r.kind === 'retry') expect(r.runAt).toBe(t + (RETRY_WAITS_MS[attempts - 1] ?? 0));
        },
      ),
    );
  });
});

type Behaviour = 'ok' | 'retry' | 'permanent' | 'throws';
type Op =
  | { kind: 'enqueue'; type: string; dedupe: number | undefined; behaviour: Behaviour }
  | { kind: 'run' }
  | { kind: 'crash' }
  | { kind: 'advance'; ms: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('enqueue' as const),
      type: fc.constantFrom('a', 'b', 'sin_manejador'),
      dedupe: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
      behaviour: fc.constantFrom<Behaviour>('ok', 'retry', 'permanent', 'throws'),
    }),
  },
  { weight: 5, arbitrary: fc.constant<Op>({ kind: 'run' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: 'crash' }) },
  {
    weight: 5,
    arbitrary: fc
      .constantFrom(30_000, 90_000, 6 * MS.minute, 40 * MS.minute, 3 * MS.hour, 13 * MS.hour)
      .map((ms): Op => ({ kind: 'advance', ms })),
  },
);

const setup = () => {
  const clock = new FakeClock(1_000_000);
  const store = new MemoryJobStore();
  const logger = new MemoryLogger();
  const auditStore = new MemoryAuditStore();
  const audit = new AuditLog(auditStore, logger, clock);
  const registry = new JobHandlerRegistry();
  const queue = new JobQueue({
    store,
    registry,
    clock,
    logger,
    audit,
    notifier: new LoggingOperatorNotifier(logger),
  });
  return { clock, store, registry, queue, auditStore };
};

describe('P-U1-11 cola de trabajos (modelo de referencia)', () => {
  it('attempts <= 6, terminales no se reejecutan, sin dedupeKey duplicada no terminal y un reclamo a la vez', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 60 }), async (ops) => {
        const { clock, store, registry, queue, auditStore } = setup();
        const behaviours = new Map<string, Behaviour>();
        const executedAttempts = new Set<string>();
        const terminalSeen = new Set<string>();
        // Las violaciones se acumulan: una excepcion dentro del manejador la tragaria la cola.
        const violations: string[] = [];

        const handler: JobHandler = (job) => {
          const key = `${job.id}#${job.attempts}`;
          // Un mismo intento de un mismo trabajo solo lo ejecuta un reclamo.
          if (executedAttempts.has(key)) violations.push(`doble ejecucion ${key}`);
          executedAttempts.add(key);
          if (terminalSeen.has(job.id)) violations.push(`terminal reejecutado ${job.id}`);
          if (job.attempts > MAX_ATTEMPTS) violations.push(`intentos ${job.attempts}`);
          const b = behaviours.get(job.id) ?? 'ok';
          if (b === 'throws') return Promise.reject(new Error('boom'));
          if (b === 'ok') return Promise.resolve({ ok: true as const });
          return Promise.resolve({
            ok: false as const,
            error: { retryable: b === 'retry', message: 'fallo simulado' },
          });
        };
        registry.register('a', handler).register('b', handler);

        const check = () => {
          const live = new Map<string, string>();
          for (const job of store.jobs.values()) {
            expect(job.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
            if (isTerminal(job.status)) terminalSeen.add(job.id);
            if (job.dedupeKey !== undefined && !isTerminal(job.status)) {
              expect(live.has(job.dedupeKey)).toBe(false);
              live.set(job.dedupeKey, job.id);
            }
          }
        };

        for (const op of ops) {
          if (op.kind === 'enqueue') {
            const job = await queue.enqueue({
              type: op.type,
              ...(op.dedupe !== undefined ? { dedupeKey: `k${op.dedupe}` } : {}),
            });
            if (!behaviours.has(job.id)) behaviours.set(job.id, op.behaviour);
          } else if (op.kind === 'run') {
            await queue.runBatch({ correlationId: 'c' });
          } else if (op.kind === 'crash') {
            // Un proceso reclama y muere sin resolver: el bloqueo vence mas tarde.
            await store.claim(clock.now(), 1, LEASE_MS);
          } else {
            clock.advance(op.ms);
          }
          check();
          expect(violations).toEqual([]);
        }

        // Todo fallo terminal deja exactamente un AuditEvent job_failed.
        const failed = [...store.jobs.values()].filter((j) => j.status === 'failed').length;
        expect(auditStore.events.filter((e) => e.action === 'job_failed').length).toBe(failed);
      }),
    );
  });
});

describe('P-U1-12 encolar con la misma dedupeKey', () => {
  it('encolar dos veces equivale a encolar una', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 5 }),
        async (key, times) => {
          const { queue, store } = setup();
          const first = await queue.enqueue({ type: 'a', dedupeKey: key });
          for (let i = 1; i < times; i++) {
            const again = await queue.enqueue({ type: 'a', dedupeKey: key });
            expect(again.id).toBe(first.id);
          }
          expect(store.jobs.size).toBe(1);
        },
      ),
    );
  });
});
