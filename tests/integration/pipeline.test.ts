import { afterAll, beforeAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { systemClock } from '@/modules/kernel/domain/clock';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { ErrorHandler } from '@/modules/platform/application/error-handler';
import { noSessionResolver } from '@/modules/platform/application/ports';
import { RateLimiter } from '@/modules/platform/application/rate-limiter';
import type { RouteTable } from '@/modules/platform/domain/route-table';
import type { Db } from '@/modules/platform/infrastructure/db-client';
import { PgAuditStore, PgCounterStore } from '@/modules/platform/infrastructure/pg-stores';
import { createPipeline } from '@/modules/platform/infrastructure/request-pipeline';
import { createSubjectHasher } from '@/modules/platform/infrastructure/subject-hasher';
import { MemoryLogger } from '@tests/support/fakes';
import { connectTestDb, describeDb, resetDatabase } from './helpers';

const table: RouteTable = [
  { pattern: '/limitada', access: 'public', rateLimit: 'checkout_ip', failClosed: true },
];

const build = (db: Db) => {
  const logger = new MemoryLogger();
  const audit = new AuditLog(new PgAuditStore(db), logger, systemClock);
  return createPipeline({
    table,
    sessions: noSessionResolver,
    limiter: new RateLimiter({
      store: new PgCounterStore(db),
      hasher: createSubjectHasher('s'.repeat(32)),
      clock: systemClock,
      audit,
      logger,
    }),
    errors: new ErrorHandler(logger, audit),
    logger,
    isDev: false,
  });
};

const request = (ip: string) =>
  new NextRequest('http://localhost:3000/limitada', { headers: { 'x-forwarded-for': ip } });

describeDb('Pipeline con Postgres real', () => {
  let db: Db;

  beforeAll(async () => {
    db = connectTestDb();
    await resetDatabase(db);
  });

  afterAll(async () => {
    await db?.end();
  });

  it('checkout_ip (10 por minuto): al superar el limite responde 429 con Retry-After y deja AuditEvent', async () => {
    const pipeline = build(db);
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    // 25 peticiones en menos de un segundo: como mucho cruzan una frontera de ventana.
    for (let i = 0; i < 25; i++) {
      const res = await pipeline(request('203.0.113.50'));
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get('retry-after');
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(10);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);

    const audit = await db.query(`SELECT 1 FROM audit_events WHERE action = 'rate_limited'`);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('otra IP tiene su propio contador y nunca se guarda en claro', async () => {
    const pipeline = build(db);
    expect((await pipeline(request('198.51.100.7'))).status).toBe(200);
    const stored = await db.query<{ subject_hash: string }>(
      'SELECT subject_hash FROM rate_limit_counters',
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) {
      expect(row.subject_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.subject_hash).not.toContain('203.0.113');
    }
  });

  it('BR-L4: con el almacen de contadores caido, una ruta cerrada responde 503', async () => {
    const dead = connectTestDb();
    await dead.end(); // cualquier consulta posterior falla
    const pipeline = build(dead);
    const res = await pipeline(request('192.0.2.9'));
    expect(res.status).toBe(503);
  });
});
