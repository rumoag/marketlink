import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantOf, MS } from '@/modules/kernel/domain/clock';
import type { Db } from '@/modules/platform/infrastructure/db-client';
import { PgAuditStore, PgCounterStore } from '@/modules/platform/infrastructure/pg-stores';
import { PgJobStore } from '@/modules/jobs/infrastructure/pg-job-store';
import { JobHandlerRegistry, JobQueue } from '@/modules/jobs/application/job-queue';
import { LEASE_MS } from '@/modules/jobs/domain/job';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { LoggingOperatorNotifier } from '@/modules/platform/application/operator-notifier';
import { FakeClock } from '@tests/support/generators';
import { MemoryLogger } from '@tests/support/fakes';
import { connectTestDb, describeDb, resetDatabase, applyMigrations } from './helpers';

describeDb('Base de datos (Postgres real)', () => {
  let db: Db;

  beforeAll(async () => {
    db = connectTestDb();
    await resetDatabase(db);
  });

  afterAll(async () => {
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE jobs, rate_limit_counters, webhook_events');
  });

  /** Ejecuta `sql` con el rol indicado, como lo haria la aplicacion o la API publica. */
  const asRole = async (role: string, sql: string, params: unknown[] = []) => {
    return db.transaction(async (client) => {
      await client.query(`SET LOCAL ROLE ${role}`);
      return client.query(sql, params);
    });
  };

  it('las migraciones son idempotentes (aditivas): aplicarlas dos veces no falla', async () => {
    await expect(applyMigrations(db)).resolves.toBeUndefined();
  });

  it('contadores: 50 incrementos concurrentes dan exactamente 1..50 (atomicidad, PF3)', async () => {
    const store = new PgCounterStore(db);
    const window = 1_700_000_000;
    const values = await Promise.all(
      Array.from({ length: 50 }, () => store.increment('quote_ip', 'hash-a', window)),
    );
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    // Otra ventana y otro sujeto empiezan desde 1.
    expect(await store.increment('quote_ip', 'hash-a', window + 60)).toBe(1);
    expect(await store.increment('quote_ip', 'hash-b', window)).toBe(1);
  });

  it('audit_events: la aplicacion puede insertar y leer, pero no modificar ni borrar (SECURITY-14)', async () => {
    const store = new PgAuditStore(db);
    await store.append({
      occurredAt: instantOf(Date.now()),
      actorType: 'anonymous',
      action: 'rate_limited',
      outcome: 'denied',
      correlationId: 'c-1',
      details: { rule: 'quote_ip' },
    });
    const read = await asRole('marketlink_app', 'SELECT action FROM audit_events');
    expect(read.rows).toEqual([{ action: 'rate_limited' }]);

    await expect(
      asRole('marketlink_app', "UPDATE audit_events SET outcome = 'success'"),
    ).rejects.toThrow(/permission denied/i);
    await expect(asRole('marketlink_app', 'DELETE FROM audit_events')).rejects.toThrow(
      /permission denied/i,
    );
    await expect(asRole('marketlink_app', 'TRUNCATE audit_events')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('anon y authenticated no acceden a ninguna tabla de U1 (RLS y privilegios)', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['jobs', 'rate_limit_counters', 'audit_events', 'webhook_events']) {
        await expect(asRole(role, `SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(
          /permission denied/i,
        );
      }
    }
  });

  it('RLS esta activada en todas las tablas de U1', async () => {
    const res = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname IN ('jobs', 'rate_limit_counters', 'audit_events', 'webhook_events')`,
    );
    expect(res.rows).toHaveLength(4);
    expect(res.rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('webhook_events: la restriccion unica (provider, event_id) da idempotencia', async () => {
    const insert = () =>
      db.query(
        `INSERT INTO webhook_events (provider, event_id, event_type) VALUES ('stripe', 'evt_1', 'x')
         ON CONFLICT (provider, event_id) DO NOTHING`,
      );
    expect((await insert()).rowCount).toBe(1);
    expect((await insert()).rowCount).toBe(0);
    await expect(
      db.query(
        `INSERT INTO webhook_events (provider, event_id, event_type) VALUES ('stripe', 'evt_1', 'x')`,
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  describe('cola de trabajos', () => {
    it('dedupeKey: 20 encolados concurrentes crean un solo trabajo; tras terminar se permite otro (BR-J7)', async () => {
      const store = new PgJobStore(db);
      const now = instantOf(Date.now());
      const jobs = await Promise.all(
        Array.from({ length: 20 }, () => store.enqueue({ type: 'x', dedupeKey: 'unica' }, now)),
      );
      expect(new Set(jobs.map((j) => j.id)).size).toBe(1);

      const [claimed] = await store.claim(now, 1, LEASE_MS);
      expect(claimed?.status).toBe('running');
      expect((await store.enqueue({ type: 'x', dedupeKey: 'unica' }, now)).id).toBe(claimed?.id);

      await store.complete(claimed?.id ?? '', now);
      const again = await store.enqueue({ type: 'x', dedupeKey: 'unica' }, now);
      expect(again.id).not.toBe(claimed?.id);
    });

    it('el reclamo pone los trabajos de eventos antes que los periodicos (ADR 0030)', async () => {
      const store = new PgJobStore(db);
      const old = instantOf(Date.now() - 3_600_000);
      const now = instantOf(Date.now());
      for (let i = 0; i < 30; i++) {
        await store.enqueue({ type: 'poll_shipments', dedupeKey: `p-${i}` }, old);
      }
      const event = await store.enqueue({ type: 'process_stripe_event', dedupeKey: 'ev' }, now);
      const claimed = await store.claim(now, 25, LEASE_MS);
      expect(claimed).toHaveLength(25);
      expect(claimed[0]?.id).toBe(event.id);
      expect(claimed.slice(1).every((j) => j.type === 'poll_shipments')).toBe(true);
    });

    it('un periodico con clave fija nunca tiene mas de un pendiente (la cola no crece si nadie consume)', async () => {
      const store = new PgJobStore(db);
      const now = instantOf(Date.now());
      const ids = new Set<string>();
      for (let minute = 0; minute < 50; minute++) {
        const j = await store.enqueue(
          { type: 'poll_shipments', dedupeKey: 'periodic:poll_shipments' },
          instantOf(now + minute * 60_000),
        );
        ids.add(j.id);
      }
      expect(ids.size).toBe(1);
    });

    it('reclamo exclusivo: 5 reclamos concurrentes reparten 20 trabajos sin duplicados (BR-J5)', async () => {
      const store = new PgJobStore(db);
      const now = instantOf(Date.now());
      for (let i = 0; i < 20; i++) await store.enqueue({ type: 'x', payload: { i } }, now);

      const batches = await Promise.all(
        Array.from({ length: 5 }, () => store.claim(now, 10, LEASE_MS)),
      );
      const ids = batches.flat().map((j) => j.id);
      expect(ids).toHaveLength(20);
      expect(new Set(ids).size).toBe(20);
      expect(batches.flat().every((j) => j.attempts === 1 && j.status === 'running')).toBe(true);
    });

    it('R-04: un bloqueo vencido lo recupera un solo ejecutor aunque haya dos a la vez', async () => {
      const store = new PgJobStore(db);
      const now = instantOf(Date.now());
      await store.enqueue({ type: 'x' }, now);
      await store.claim(now, 1, LEASE_MS); // el proceso muere

      const later = instantOf(now + LEASE_MS + 1);
      const [a, b] = await Promise.all([
        store.takeExpired(later, 10, LEASE_MS),
        store.takeExpired(later, 10, LEASE_MS),
      ]);
      expect(a.length + b.length).toBe(1);
    });

    it('R-03: reintentos con espera creciente hasta failed, con AuditEvent job_failed', async () => {
      const clock = new FakeClock(Date.now());
      const logger = new MemoryLogger();
      const registry = new JobHandlerRegistry().register('siempre_falla', () =>
        Promise.resolve({ ok: false as const, error: { retryable: true, message: 'fallo' } }),
      );
      const queue = new JobQueue({
        store: new PgJobStore(db),
        registry,
        clock,
        logger,
        audit: new AuditLog(new PgAuditStore(db), logger, clock),
        notifier: new LoggingOperatorNotifier(logger),
      });
      const job = await queue.enqueue({ type: 'siempre_falla' });
      for (let i = 0; i < 6; i++) {
        await queue.runBatch({ correlationId: 'c' });
        clock.advance(13 * MS.hour);
      }
      const row = await db.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM jobs WHERE id = $1',
        [job.id],
      );
      expect(row.rows[0]).toEqual({ status: 'failed', attempts: 6 });
      const audit = await db.query(
        'SELECT 1 FROM audit_events WHERE action = $1 AND resource_id = $2',
        ['job_failed', job.id],
      );
      expect(audit.rowCount).toBe(1);
    });

    it('la restriccion de attempts impide superar 6', async () => {
      await expect(db.query(`INSERT INTO jobs (type, attempts) VALUES ('x', 7)`)).rejects.toThrow(
        /check constraint/i,
      );
    });
  });
});
