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
import type { Order } from '@/modules/orders/domain/order';
import { ReconcileLedger, RecomputeBalances } from '@/modules/payouts/application/money-reports';
import { recordPayment } from '@/modules/payouts/application/record-payment';
import { RefundOrder } from '@/modules/payouts/application/refunds';
import {
  registerDelivery,
  RetrySettlements,
  SettleOrder,
} from '@/modules/payouts/application/settlement';
import { RequestWithdrawal } from '@/modules/payouts/application/withdrawals';
import { ProcessShipmentFact } from '@/modules/shipping/application/apply-fact';
import { CreateShipmentDraft } from '@/modules/shipping/application/draft';
import { OnOrderPaid } from '@/modules/shipping/application/on-paid';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { RateLimiter } from '@/modules/platform/application/rate-limiter';
import { artistScope } from '@/modules/platform/application/unit-of-work';
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
import { MemoryMoney } from '@tests/support/u5-harness';
import { connectTestDb, describeDb, resetDatabase, testDatabaseUrl } from './helpers';

const APP_PASSWORD = 'apppass-integration';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const LISTING = '00000000-0000-4000-8000-000000000101';
const SLUG = 'abcdefgh';

describeDb('U5: dinero con el rol de la aplicacion (Postgres real)', () => {
  let admin: Db;
  let app: Db;
  let runner: PgTransactionRunner<AppRepos>;
  const clock = new FakeClock(Date.UTC(2026, 10, 7, 12, 0, 0));
  const payments = new MemoryPayments();
  const shipping = new MemoryShipping();
  const provider = new MemoryShipmentProvider();
  const labels = new MemoryLabels();
  const alerts = new RecordingAlerts();
  const logger = new MemoryLogger();
  const money = new MemoryMoney();
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
      'TRUNCATE order_events, orders, reservations, listing_photos, listings, payout_accounts, sender_addresses, artists, artist_balances, withdrawals, ledger_entries, settlements, refunds, notifications, rate_limit_counters, audit_events CASCADE',
    );
    payments.sessions.clear();
    provider.drafts.clear();
    money.transfers.clear();
    money.payouts.clear();
    money.refunds.clear();
    money.transferCalls = 0;
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
      `INSERT INTO payout_accounts (artist_id, provider_account_id, status) VALUES ($1, 'acct_a', 'activo')`,
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
    const draft = new CreateShipmentDraft({ runner, provider, alerts, audit, clock, ids });
    const processFact = new ProcessShipmentFact({
      runner,
      provider,
      storage: labels,
      alerts,
      clock,
      ids,
      logger,
      onDelivered: (repos, order, now) => registerDelivery(repos as AppRepos, ids, order, now),
    });
    const base = { runner, clock, ids, audit, alerts, logger };
    const settle = new SettleOrder({
      ...base,
      provider: money,
      settlementDelayHours: 0,
      blockedAlertDays: 7,
    });
    return {
      processor,
      start,
      draft,
      processFact,
      settle,
      retry: new RetrySettlements({
        ...base,
        provider: money,
        settlementDelayHours: 0,
        blockedAlertDays: 7,
        settle,
      }),
      withdraw: new RequestWithdrawal({
        ...base,
        provider: money,
        mode: 'manual',
        recentLoginMinutes: 15,
        limiter,
      }),
      refund: new RefundOrder({ ...base, provider: money }),
      reconcile: new ReconcileLedger({ runner, clock, audit, alerts, logger }),
      recompute: new RecomputeBalances({ runner, clock, audit, alerts, logger }),
    };
  };

  /** Compra pagada, borrador creado y entregada (liquidacion pendiente creada). */
  const delivered = async () => {
    const b = build();
    unwrap(
      await b.start.execute(
        checkoutInput(SLUG, { fields: buyerFields({ email: 'c@example.com' }), ip: '10.5.0.1' }),
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
    unwrap(await b.draft.execute(o.id, 'c', false));
    const ref = (await admin.query<{ provider_ref: string }>('SELECT provider_ref FROM shipments'))
      .rows[0]!.provider_ref;
    const t = clock.now();
    await b.processFact.execute(ref, fact('label_ready', t), 'c');
    await b.processFact.execute(ref, fact('in_transit', t + 1), 'c');
    await b.processFact.execute(ref, fact('delivered', t + 2), 'c');
    return { orderId: o.id, b };
  };

  const balanceRow = async (artist = A) =>
    (
      await admin.query<{ retained_cents: number; available_cents: number }>(
        'SELECT retained_cents, available_cents FROM artist_balances WHERE artist_id = $1',
        [artist],
      )
    ).rows[0];
  const loginAt = (): number => clock.now() - 60_000;

  // -----------------------------------------------------------------------------------------
  it('flujo completo: retencion al pagar, liquidacion al entregar y retirada; libro y saldo coinciden', async () => {
    const { orderId, b } = await delivered();
    const order = (await admin.query<Order & { work_price_cents: number }>('SELECT * FROM orders'))
      .rows[0]!;
    expect(await balanceRow()).toMatchObject({ retained_cents: 25_000, available_cents: 0 });
    expect(
      (await admin.query('SELECT 1 FROM settlements WHERE order_id = $1', [orderId])).rowCount,
    ).toBe(1);

    expect(await b.settle.execute(orderId, 'c')).toMatchObject({ kind: 'transferred' });
    expect(await balanceRow()).toMatchObject({ retained_cents: 0, available_cents: 25_000 });
    expect(
      (await admin.query<{ status: string }>('SELECT status FROM orders')).rows[0]?.status,
    ).toBe('liquidado');
    expect(order.work_price_cents).toBe(25_000);

    const r = await b.withdraw.execute({ artistId: A, loginAt: loginAt(), correlationId: 'c' });
    expect(r).toMatchObject({ ok: true, status: 'enviada' });
    expect(await balanceRow()).toMatchObject({ available_cents: 0 });

    // Coherencia saldos-libro y conservacion por pedido.
    expect((await b.recompute.execute('c')).mismatches).toBe(0);
    expect((await b.reconcile.execute('c')).mismatches).toBe(0);
    expect(
      (
        await admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM notifications WHERE type = 'retirada_artista'`,
        )
      ).rows[0]?.n,
    ).toBe('1');
  });

  it('liquidacion concurrente y repetida: una sola transferencia y un solo movimiento', async () => {
    const { orderId, b } = await delivered();
    await Promise.all([
      b.settle.execute(orderId, 'c1'),
      b.settle.execute(orderId, 'c2'),
      b.settle.execute(orderId, 'c3'),
    ]);
    await b.settle.execute(orderId, 'c4');
    expect(money.transfers.size).toBe(1);
    expect(
      (await admin.query(`SELECT 1 FROM ledger_entries WHERE kind = 'liquidacion'`)).rowCount,
    ).toBe(2);
    expect(await balanceRow()).toMatchObject({ retained_cents: 0, available_cents: 25_000 });
  });

  it('retirada concurrente: solo una sale y el saldo nunca queda negativo', async () => {
    const { orderId, b } = await delivered();
    await b.settle.execute(orderId, 'c');
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        b.withdraw.execute({ artistId: A, loginAt: loginAt(), correlationId: 'c' }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(money.payouts.size).toBe(1);
    expect((await balanceRow())?.available_cents).toBe(0);
    expect((await admin.query('SELECT 1 FROM withdrawals')).rowCount).toBe(1);
  });

  it('el libro es de solo insercion y el saldo no admite valores negativos', async () => {
    await delivered();
    await expect(app.query('UPDATE ledger_entries SET delta_cents = 1')).rejects.toThrow();
    await expect(app.query('DELETE FROM ledger_entries')).rejects.toThrow();
    await expect(admin.query('UPDATE artist_balances SET available_cents = -1')).rejects.toThrow();
    // Sin contexto del sistema ni de artista, la aplicacion no ve nada ni puede escribir.
    expect((await app.query('SELECT 1 FROM ledger_entries')).rowCount).toBe(0);
    await expect(
      app.query(
        `INSERT INTO ledger_entries (kind, bucket, delta_cents, entry_key) VALUES ('ajuste', 'stripe', 1, 'x')`,
      ),
    ).rejects.toThrow();
  });

  it('un pedido solo se cobra una vez en el libro (indice unico)', async () => {
    const { orderId } = await delivered();
    await expect(
      admin.query(
        `INSERT INTO ledger_entries (order_id, kind, bucket, delta_cents, entry_key)
         VALUES ($1, 'cobro', 'stripe', 5, 'otra-clave')`,
        [orderId],
      ),
    ).rejects.toThrow();
  });

  it('RLS: una artista solo ve sus movimientos, saldos y liquidaciones', async () => {
    const { orderId, b } = await delivered();
    await b.settle.execute(orderId, 'c');
    const seen = await runner.run(artistScope(B), async (r) => ({
      ledger: await r.ledger.listByArtist(A, 10),
      balance: await r.balances.find(A),
      settlement: await r.settlements.findByOrder(orderId),
      refunds: await r.refunds.listByOrder(orderId),
    }));
    expect(seen.ledger).toHaveLength(0);
    expect(seen.balance).toBeUndefined();
    expect(seen.settlement).toBeUndefined();
    expect(seen.refunds).toHaveLength(0);
    const own = await runner.run(artistScope(A), (r) => r.ledger.listByArtist(A, 10));
    expect(own.length).toBeGreaterThan(0);
  });

  it('reembolso total antes de liquidar: libro conservado, pedido reembolsado, liquidacion anulada', async () => {
    const { orderId, b } = await delivered();
    const r = await b.refund.execute({
      orderId,
      amountCents: 25_450,
      reason: 'peticion_compradora',
      operatorId: 'op',
      correlationId: 'c',
    });
    expect(r).toMatchObject({ ok: true, total: true });
    expect(await balanceRow()).toMatchObject({ retained_cents: 0, available_cents: 0 });
    await b.settle.execute(orderId, 'c');
    expect(
      (await admin.query<{ status: string }>('SELECT status FROM settlements')).rows[0]?.status,
    ).toBe('anulada');
    expect((await b.reconcile.execute('c')).mismatches).toBe(0);
    expect(
      (await admin.query<{ status: string }>('SELECT status FROM orders')).rows[0]?.status,
    ).toBe('reembolsado');
  });

  it('la bandeja de liquidaciones reserva con SKIP LOCKED: dos ejecutores no procesan la misma', async () => {
    const { orderId, b } = await delivered();
    const [x, y] = await Promise.all([b.retry.execute('c1'), b.retry.execute('c2')]);
    expect(x.examined + y.examined).toBe(1);
    expect(money.transfers.size).toBe(1);
    expect(orderId).toBeDefined();
    clock.advance(MS.minute);
  });
});
