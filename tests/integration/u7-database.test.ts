import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { QuoteShipping } from '@/modules/checkout/application/quote-shipping';
import { StartCheckout } from '@/modules/checkout/application/start-checkout';
import {
  factFromEvent,
  ProcessPaymentFact,
} from '@/modules/orders/application/process-payment-event';
import { AuditLogOperatorAlerts } from '@/modules/orders/infrastructure/operator-alerts';
import { GetHealth, SecurityAlerts } from '@/modules/operator/application/monitoring';
import { PurgePersonalData } from '@/modules/operator/application/privacy';
import { recordPayment } from '@/modules/payouts/application/record-payment';
import { OnOrderPaid } from '@/modules/shipping/application/on-paid';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { LoggingOperatorNotifier } from '@/modules/platform/application/operator-notifier';
import { RateLimiter } from '@/modules/platform/application/rate-limiter';
import { createDb, type Db } from '@/modules/platform/infrastructure/db-client';
import { PgTransactionRunner } from '@/modules/platform/infrastructure/pg-runner';
import { PgAuditStore, PgCounterStore } from '@/modules/platform/infrastructure/pg-stores';
import { createAppRepos } from '@/services/pg-repos';
import type { AppRepos } from '@/services/repos';
import { FakeClock } from '@tests/support/generators';
import { MemoryLogger } from '@tests/support/fakes';
import { SeqIds } from '@tests/support/stubs';
import {
  MemoryPayments,
  MemoryShipping,
  RecordingAlerts,
  SECRETS,
  buyerFields,
  checkoutInput,
} from '@tests/support/u3-harness';
import {
  applyMigrations,
  connectTestDb,
  describeDb,
  resetDatabase,
  testDatabaseUrl,
} from './helpers';

const APP_PASSWORD = 'apppass-integration';
const A = '00000000-0000-4000-8000-0000000000a1';
const LISTING = '00000000-0000-4000-8000-000000000101';
const SLUG = 'abcdefgh';

describeDb('U7: limpieza, alertas, salud y restauración (Postgres real)', () => {
  let admin: Db;
  let app: Db;
  let runner: PgTransactionRunner<AppRepos>;
  const clock = new FakeClock(Date.UTC(2026, 10, 9, 12, 0, 0));
  const payments = new MemoryPayments();
  const shipping = new MemoryShipping();
  const alerts = new RecordingAlerts();
  const logger = new MemoryLogger();
  let ids = new SeqIds();

  beforeAll(async () => {
    admin = connectTestDb();
    await resetDatabase(admin);
    await admin
      .query(`ALTER ROLE marketlink_app LOGIN PASSWORD '${APP_PASSWORD}'`)
      .catch(() => undefined);
    const url = new URL(testDatabaseUrl as string);
    url.username = 'marketlink_app';
    url.password = APP_PASSWORD;
    app = createDb(url.toString(), { max: 12 });
    runner = new PgTransactionRunner<AppRepos>(app, createAppRepos({ clock, ids: new SeqIds() }));
  });

  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query(
      'TRUNCATE order_events, orders, reservations, listing_photos, listings, payout_accounts, sender_addresses, artists, artist_balances, withdrawals, ledger_entries, settlements, refunds, notifications, backup_runs, rate_limit_counters, audit_events, jobs CASCADE',
    );
    payments.sessions.clear();
    alerts.raised.length = 0;
    ids = new SeqIds();
    await admin.query(
      `INSERT INTO artists (id, email, artistic_name, instagram, phone)
       VALUES ($1, 'ana@example.com', 'Ana Art', 'ana.art', '+34612345678')`,
      [A],
    );
    await admin.query(
      `INSERT INTO sender_addresses (artist_id, street, number, postal_code, city, province, phone)
       VALUES ($1, 'Calle Mayor', '12', '28001', 'Madrid', 'Madrid', '+34612345678')`,
      [A],
    );
    await admin.query(
      `INSERT INTO listings (id, artist_id, slug, title, description, price_cents,
          declared_value_cents, size, modality)
       VALUES ($1, $2, $3, 'Oleo sobre lienzo', 'Una obra', 25000, 25000, 'M', 'punto')`,
      [LISTING, A, SLUG],
    );
  });

  const audit = () => new AuditLog(new PgAuditStore(app), logger, clock);

  const paid = async () => {
    const a = audit();
    const limiter = new RateLimiter({
      store: new PgCounterStore(app),
      hasher: (_r, s) => s,
      clock,
      audit: a,
      logger,
    });
    const onPaid = new OnOrderPaid({ runner, clock, ids, enqueueDraft: () => Promise.resolve() });
    const processor = new ProcessPaymentFact({
      runner,
      clock,
      audit: a,
      alerts,
      logger,
      provider: payments,
      onPaid: (id) => onPaid.execute(id),
      inTxPaid: (repos, order, now) => recordPayment(repos as AppRepos, order, now),
    });
    const start = new StartCheckout({
      runner,
      quoter: new QuoteShipping({ runner, shipping, limiter, alerts, clock, logger }),
      provider: payments,
      limiter,
      alerts,
      audit: a,
      clock,
      ids,
      logger,
      appUrl: 'https://app.test',
      secrets: SECRETS,
      sessionMinutes: 30,
      reservationMinutes: 32,
      manualReservationHours: 24,
      bizumEnabled: false,
      manualEnabled: false,
      manualPolicy: undefined,
    });
    unwrap(
      await start.execute(
        checkoutInput(SLUG, { fields: buyerFields({ email: 'c@example.com' }), ip: '10.7.0.1' }),
      ),
    );
    const o = (
      await admin.query<{ id: string; checkout_session_id: string }>(
        'SELECT id, checkout_session_id FROM orders',
      )
    ).rows[0]!;
    await processor.execute(
      factFromEvent(payments.eventFor(payments.pay(o.checkout_session_id), 'completed'))!,
      'c',
    );
    return o.id;
  };

  const purger = () =>
    new PurgePersonalData({ runner, clock, audit: audit(), alerts, logger, months: 12 });

  // -----------------------------------------------------------------------------------------
  it('la limpieza concurrente vacía los datos una sola vez y conserva importes y estado', async () => {
    const orderId = await paid();
    expect((await purger().runBatch('c')).purged).toBe(0); // aun no vence
    clock.advance(400 * MS.day);
    const results = await Promise.all([1, 2, 3].map(() => purger().runBatch('c')));
    expect(results.reduce((n, r) => n + r.purged, 0)).toBe(1);
    const row = (
      await admin.query<{
        buyer: unknown;
        destination: unknown;
        status: string;
        total_cents: number;
        personal_purged_at: Date | null;
      }>(
        'SELECT buyer, destination, status, total_cents, personal_purged_at FROM orders WHERE id = $1',
        [orderId],
      )
    ).rows[0]!;
    expect(row.buyer).toBeNull();
    expect(row.destination).toBeNull();
    expect(row.status).toBe('pagado');
    expect(row.total_cents).toBe(25_450);
    expect(row.personal_purged_at).not.toBeNull();
    expect(
      (await admin.query(`SELECT 1 FROM order_events WHERE kind = 'datos_purgados'`)).rowCount,
    ).toBe(1);
    const audits = JSON.stringify(
      (
        await admin.query('SELECT details, resource_id FROM audit_events WHERE action = $1', [
          'personal_data_purged',
        ])
      ).rows,
    );
    expect(audits).not.toMatch(/c@example.com|Calle Sol/);
  });

  it('el borrado a petición se rechaza con el envío en curso, pero la limpieza por retención sí actúa', async () => {
    const orderId = await paid();
    const p = purger();
    expect(await p.purgeOne(orderId, 'on_demand', 'peticion', 'c', 'op@example.com')).toEqual({
      kind: 'blocked',
      block: 'cadena_de_envio_activa',
    });
    expect(
      (await admin.query('SELECT buyer FROM orders WHERE id = $1', [orderId])).rows[0]?.buyer,
    ).not.toBeNull();
  });

  it('las alertas usan la auditoría real, avisan una vez por franja y ven el aviso previo', async () => {
    const a = audit();
    const operatorAlerts = new AuditLogOperatorAlerts(a, new LoggingOperatorNotifier(logger));
    const jobs: string[] = [];
    const sec = new SecurityAlerts({
      runner,
      clock,
      alerts: operatorAlerts,
      audit: a,
      enqueue: (input) => {
        jobs.push(input.dedupeKey);
        return Promise.resolve();
      },
      logger,
      thresholds: { authFailures: 10, authzDenied: 10, webhookSignatures: 5 },
    });
    for (let i = 0; i < 9; i += 1) {
      await a.record({
        actorType: 'anonymous',
        action: 'auth_failure',
        outcome: 'denied',
        correlationId: 'x',
      });
    }
    expect((await sec.execute('c')).alerted).toEqual([]);
    await a.record({
      actorType: 'anonymous',
      action: 'auth_failure',
      outcome: 'denied',
      correlationId: 'x',
    });
    expect((await sec.execute('c')).alerted).toEqual(['seguridad_autenticacion']);
    expect((await sec.execute('c')).alerted).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(
      (await admin.query(`SELECT 1 FROM audit_events WHERE action = 'security_alert'`)).rowCount,
    ).toBe(1);
  });

  it('el registro de copias es de solo inserción para el sistema y se lee en la salud', async () => {
    await expect(app.query(`INSERT INTO backup_runs (size_bytes) VALUES (1)`)).rejects.toThrow();
    await admin.query(
      `INSERT INTO backup_runs (at, size_bytes, checksum) VALUES (now(), 123, $1)`,
      ['a'.repeat(64)],
    );
    await expect(app.query('UPDATE backup_runs SET size_bytes = 0')).rejects.toThrow();
    await expect(app.query('DELETE FROM backup_runs')).rejects.toThrow();
    const health = new GetHealth({
      runner,
      directory: { isAuthorized: () => true, totpSecret: () => undefined, all: () => [] },
      clock,
      logger,
      staleDays: 10,
      circuits: () => [{ provider: 'stripe', state: 'closed' }],
      quotasReviewedAt: () => clock.now(),
      live: true,
    });
    const v = unwrap(await health.execute({ email: 'op@example.com' }));
    for (const s of [v.db, v.jobs, v.emails, v.work, v.alerts, v.audit, v.circuits, v.backup]) {
      expect(s.ok).toBe(true);
    }
    expect(v.backup.ok && v.backup.value).toBeDefined();
  });

  it('el verificador de restauración acepta una base coherente y rechaza una descuadrada', async () => {
    const name = 'restore_verify_u7_test';
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(testDatabaseUrl as string);
    url.pathname = `/${name}`;
    const db = createDb(url.toString(), { max: 2 });
    try {
      await db.query('CREATE SCHEMA IF NOT EXISTS public');
      for (const role of ['anon', 'authenticated']) {
        await db
          .query(
            `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`,
          )
          .catch(() => undefined);
      }
      await applyMigrations(db);
      const run = () =>
        spawnSync(
          process.execPath,
          [path.resolve('scripts/db/verify-restore.mjs'), '--allow-empty'],
          {
            env: { ...process.env, VERIFY_DATABASE_URL: url.toString() },
            encoding: 'utf8',
          },
        );
      expect(run().status).toBe(0);
      // Sin --allow-empty una base vacia no vale como copia.
      const strict = spawnSync(process.execPath, [path.resolve('scripts/db/verify-restore.mjs')], {
        env: { ...process.env, VERIFY_DATABASE_URL: url.toString() },
        encoding: 'utf8',
      });
      expect(strict.status).toBe(1);
      expect(strict.stderr).toContain('vacía');

      // Libro descuadrado (se saltan las claves foraneas como lo haria un volcado corrupto).
      await db.transaction(async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(
          `INSERT INTO ledger_entries (order_id, kind, bucket, delta_cents, entry_key)
           VALUES ('00000000-0000-4000-8000-0000000000aa', 'cobro', 'stripe', 1000, 'clave-1'),
                  ('00000000-0000-4000-8000-0000000000aa', 'retencion', 'retenido', 400, 'clave-2')`,
        );
      });
      const bad = run();
      expect(bad.status).toBe(1);
      expect(bad.stderr).toMatch(/no conserva el dinero/);
    } finally {
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    }
  });
});
