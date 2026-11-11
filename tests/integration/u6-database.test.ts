import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { ShippingOptionsFinder } from '@/modules/checkout/application/shipping-options';
import { InMemoryProviderCache } from '../support/memory-cache';
import { StartCheckout } from '@/modules/checkout/application/start-checkout';
import {
  factFromEvent,
  ProcessPaymentFact,
} from '@/modules/orders/application/process-payment-event';
import { stuckReason } from '@/modules/operator/domain/stuck';
import { recordPayment } from '@/modules/payouts/application/record-payment';
import { ProcessShipmentFact } from '@/modules/shipping/application/apply-fact';
import { CreateShipmentDraft } from '@/modules/shipping/application/draft';
import { OnOrderPaid } from '@/modules/shipping/application/on-paid';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { RateLimiter } from '@/modules/platform/application/rate-limiter';
import { artistScope, systemScope } from '@/modules/platform/application/unit-of-work';
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
import { MemoryLabels, MemoryShipmentProvider, fact } from '@tests/support/u4-harness';
import { connectTestDb, describeDb, resetDatabase, testDatabaseUrl } from './helpers';

const APP_PASSWORD = 'apppass-integration';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const LISTING = '00000000-0000-4000-8000-000000000101';
const SLUG = 'abcdefgh';
const OP = 'op@example.com';

describeDb('U6: panel del operador con el rol de la aplicacion (Postgres real)', () => {
  let admin: Db;
  let app: Db;
  let runner: PgTransactionRunner<AppRepos>;
  const clock = new FakeClock(Date.UTC(2026, 10, 8, 12, 0, 0));
  const payments = new MemoryPayments();
  const shipping = new MemoryShipping();
  const provider = new MemoryShipmentProvider();
  const labels = new MemoryLabels();
  const alerts = new RecordingAlerts();
  const logger = new MemoryLogger();
  let ids = new SeqIds();

  beforeAll(async () => {
    admin = connectTestDb();
    await resetDatabase(admin);
    await admin.query(`ALTER ROLE marketlink_app LOGIN PASSWORD '${APP_PASSWORD}'`);
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
      'TRUNCATE order_events, orders, reservations, listing_photos, listings, payout_accounts, sender_addresses, artists, artist_balances, withdrawals, ledger_entries, settlements, refunds, notifications, operator_totp_state, listing_views, rate_limit_counters, audit_events CASCADE',
    );
    payments.sessions.clear();
    provider.drafts.clear();
    provider.createCalls = 0;
    provider.created = 0;
    alerts.raised.length = 0;
    ids = new SeqIds();
    for (const [id, mail] of [
      [A, 'ana@example.com'],
      [B, 'berta@example.com'],
    ] as const) {
      await admin.query(
        `INSERT INTO artists (id, email, artistic_name, instagram, phone)
         VALUES ($1, $2, 'Ana Art', 'ana.art', '+34612345678')`,
        [id, mail],
      );
    }
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

  const build = () => {
    const audit = new AuditLog(new PgAuditStore(app), logger, clock);
    const limiter = new RateLimiter({
      store: new PgCounterStore(app),
      hasher: (_r, s) => s,
      clock,
      audit,
      logger,
    });
    const quoter = new ShippingOptionsFinder({
      shipping,
      points: shipping,
      cache: new InMemoryProviderCache(),
      alerts,
      clock,
      logger,
      cacheTtlMs: 600_000,
    });
    const onPaid = new OnOrderPaid({ runner, clock, ids, enqueueDraft: () => Promise.resolve() });
    const processor = new ProcessPaymentFact({
      runner,
      clock,
      audit,
      alerts,
      logger,
      provider: payments,
      onPaid: (id) => onPaid.execute(id),
      inTxPaid: (repos, order, now) => recordPayment(repos as AppRepos, order, now),
    });
    const start = new StartCheckout({
      runner,
      finder: quoter,
      provider: payments,
      limiter,
      alerts,
      audit,
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
    return {
      processor,
      start,
      draft: new CreateShipmentDraft({ runner, provider, alerts, audit, clock, ids }),
      processFact: new ProcessShipmentFact({
        runner,
        provider,
        storage: labels,
        alerts,
        clock,
        ids,
        logger,
      }),
    };
  };

  const paid = async () => {
    const b = build();
    unwrap(
      await b.start.execute(
        checkoutInput(SLUG, { fields: buyerFields({ email: 'c@example.com' }), ip: '10.6.0.1' }),
      ),
    );
    const o = (
      await admin.query<{ id: string; checkout_session_id: string }>(
        'SELECT id, checkout_session_id FROM orders',
      )
    ).rows[0]!;
    await b.processor.execute(
      factFromEvent(payments.eventFor(payments.pay(o.checkout_session_id), 'completed'))!,
      'c',
    );
    return { orderId: o.id, b };
  };

  const list = (filter: Parameters<AppRepos['operator']['listOrders']>[0]) =>
    runner.run(systemScope, (r) => r.operator.listOrders(filter, 25, 0, clock.now(), 10));

  // -----------------------------------------------------------------------------------------
  it('las tablas del operador son invisibles para una artista y las notas son de solo insercion', async () => {
    const { orderId } = await paid();
    await runner.run(systemScope, async (r) => {
      await r.operator.addNote({
        id: ids.uuid(),
        orderId,
        author: OP,
        at: clock.now(),
        text: 'nota',
        formKey: 'clave-0001',
      });
      await r.operator.openFlag({
        id: ids.uuid(),
        orderId,
        reason: 'x',
        openedBy: OP,
        openedAt: clock.now(),
        resolution: undefined,
        closedBy: undefined,
        closedAt: undefined,
      });
      await r.operator.acceptStep(OP, 5, clock.now());
    });
    const seen = await runner.run(artistScope(A), async (r) => ({
      notes: await r.operator.listNotes(orderId),
      flags: await r.operator.listFlags(orderId),
      totp: await r.operator.getTotpState(OP),
    }));
    expect(seen).toEqual({ notes: [], flags: [], totp: undefined });
    await expect(app.query('UPDATE operator_notes SET text = $1', ['x'])).rejects.toThrow();
    await expect(app.query('DELETE FROM operator_notes')).rejects.toThrow();
    await expect(
      runner.run(artistScope(A), (r) =>
        r.operator.addNote({
          id: ids.uuid(),
          orderId,
          author: 'a',
          at: clock.now(),
          text: 't',
          formKey: 'clave-0002',
        }),
      ),
    ).rejects.toThrow();
  });

  it('una sola incidencia abierta por pedido incluso en concurrencia', async () => {
    const { orderId } = await paid();
    const open = (n: number) =>
      runner.run(systemScope, (r) =>
        r.operator.openFlag({
          id: ids.uuid(),
          orderId,
          reason: `motivo ${n}`,
          openedBy: OP,
          openedAt: clock.now(),
          resolution: undefined,
          closedBy: undefined,
          closedAt: undefined,
        }),
      );
    const results = await Promise.all([1, 2, 3, 4, 5].map(open));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await admin.query('SELECT 1 FROM order_flags')).rowCount).toBe(1);
    const flag = await runner.run(systemScope, (r) => r.operator.findOpenFlag(orderId));
    expect(
      await runner.run(systemScope, (r) => r.operator.closeFlag(flag!.id, OP, 'ok', clock.now())),
    ).toBe(true);
    expect(await open(9)).toBe(true); // tras cerrar se puede abrir otra
    await expect(
      admin.query(`UPDATE order_flags SET closed_at = now() WHERE closed_at IS NULL`),
    ).rejects.toThrow(); // resolucion obligatoria al cerrar
  });

  it('el paso TOTP se fija de forma atomica: de varios codigos iguales solo uno vale', async () => {
    const accepted = await Promise.all(
      Array.from({ length: 8 }, () =>
        runner.run(systemScope, (r) => r.operator.acceptStep(OP, 1000, clock.now())),
      ),
    );
    expect(accepted.filter(Boolean)).toHaveLength(1);
    expect(await runner.run(systemScope, (r) => r.operator.acceptStep(OP, 999, clock.now()))).toBe(
      false,
    );
    expect(await runner.run(systemScope, (r) => r.operator.acceptStep(OP, 1001, clock.now()))).toBe(
      true,
    );
  });

  it('los fallos se cuentan sin perder ninguno bajo concurrencia y bloquean al quinto', async () => {
    const fail = () =>
      runner.run(systemScope, (r) =>
        r.operator.recordFailure(OP, clock.now(), 15 * MS.minute, 5, 15 * MS.minute),
      );
    await Promise.all(Array.from({ length: 10 }, fail));
    const s = await runner.run(systemScope, (r) => r.operator.getTotpState(OP));
    expect(s?.failures).toBe(10);
    expect(s?.lockedUntil).toBeGreaterThan(clock.now());
    await runner.run(systemScope, (r) => r.operator.resetFailures(OP, clock.now()));
    expect(
      (await runner.run(systemScope, (r) => r.operator.getTotpState(OP)))?.lockedUntil,
    ).toBeUndefined();
    // Una ventana vencida reinicia la cuenta.
    await fail();
    clock.advance(16 * MS.minute);
    expect((await fail()).failures).toBe(1);
  });

  it('el contador de visitas es exacto bajo concurrencia, sin datos de visitante, e ignora slugs desconocidos', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        runner.run(systemScope, (r) => r.operator.addView(SLUG.toUpperCase(), '2026-11-08')),
      ),
    );
    const rows = (
      await admin.query<{ count: number; day: Date }>('SELECT count, day FROM listing_views')
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(20);
    expect(await runner.run(systemScope, (r) => r.operator.addView('zzzzzzzz', '2026-11-08'))).toBe(
      false,
    );
    expect(await runner.run(systemScope, (r) => r.operator.purgeViews('2026-11-09'))).toBe(1);
  });

  it('el filtro SQL de atascados coincide con la funcion pura del dominio en cada situacion', async () => {
    const { orderId, b } = await paid();
    const check = async (expected: string | undefined) => {
      const all = await list({});
      const row = all.rows[0]!;
      const domain = stuckReason(row, clock.now(), 10);
      const sql = await list({ stuckOnly: true });
      expect(domain).toBe(expected);
      expect(sql.total).toBe(expected === undefined ? 0 : 1);
    };
    await check(undefined); // recien pagado

    unwrap(await b.draft.execute(orderId, 'c', false));
    const ref = (await admin.query<{ provider_ref: string }>('SELECT provider_ref FROM shipments'))
      .rows[0]!.provider_ref;
    await check(undefined); // borrador reciente
    clock.advance(25 * MS.hour);
    await check('borrador_sin_pagar');

    const flag = {
      id: ids.uuid(),
      orderId,
      reason: 'x',
      openedBy: OP,
      openedAt: clock.now(),
      resolution: undefined,
      closedBy: undefined,
      closedAt: undefined,
    };
    await runner.run(systemScope, (r) => r.operator.openFlag(flag));
    await check('incidencia_manual');
    await runner.run(systemScope, (r) =>
      r.operator.closeFlag(flag.id, OP, 'resuelto', clock.now()),
    );
    await check('borrador_sin_pagar');

    await b.processFact.execute(ref, fact('label_ready', clock.now()), 'c');
    await check(undefined);
    await b.processFact.execute(ref, fact('in_transit', clock.now() + 1), 'c');
    await check(undefined);
    clock.advance(11 * MS.day);
    await check('entrega_sin_confirmar');
  });

  it('la lista filtra por estado, artista y fechas, y no incluye datos personales', async () => {
    const { orderId } = await paid();
    expect((await list({ status: 'pagado' })).total).toBe(1);
    expect((await list({ status: 'entregado' })).total).toBe(0);
    expect((await list({ artistId: A })).total).toBe(1);
    expect((await list({ artistId: B })).total).toBe(0);
    expect((await list({ from: clock.now() + MS.day })).total).toBe(0);
    expect((await list({ to: clock.now() + MS.day })).total).toBe(1);
    const row = (await list({})).rows[0]!;
    expect(row.id).toBe(orderId);
    expect(JSON.stringify(row)).not.toMatch(/c@example.com|Calle Sol|612345678/);
  });

  it('las metricas cuentan lo pagado en el periodo y las visitas', async () => {
    await paid();
    const today = new Date(clock.now()).toISOString().slice(0, 10);
    await runner.run(systemScope, (r) => r.operator.addView(SLUG, today));
    const m = await runner.run(systemScope, (r) =>
      r.operator.rawMetrics(clock.now() - MS.day, clock.now() + MS.day),
    );
    expect(m).toMatchObject({ paidOrders: 1, views: 1, listingsCreated: 0, puntoOrders: 1 });
    const earlier = await runner.run(systemScope, (r) =>
      r.operator.rawMetrics(clock.now() - 10 * MS.day, clock.now() - 5 * MS.day),
    );
    expect(earlier.paidOrders).toBe(0);
  });

  it('guarda los tamanos y los lee la cotizacion', async () => {
    const saved = await runner.run(systemScope, (r) =>
      r.operator.saveSize(
        'S',
        { lengthCm: 31, widthCm: 26, heightCm: 6, weightKg: 1.25 },
        clock.now(),
      ),
    );
    expect(saved).toBe(true);
    const sizes = await runner.run(systemScope, (r) => r.sizes.list());
    expect(sizes.find((s) => s.size === 'S')).toMatchObject({ lengthCm: 31, weightKg: 1.25 });
    await expect(
      admin.query(`UPDATE size_presets SET length_cm = 0 WHERE size = 'S'`),
    ).rejects.toThrow();
  });
});
