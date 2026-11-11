import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { instantOf, MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { ShippingOptionsFinder } from '@/modules/checkout/application/shipping-options';
import { InMemoryProviderCache } from '../support/memory-cache';
import { StartCheckout } from '@/modules/checkout/application/start-checkout';
import { PurgeUnpaidOrders, ExpireStaleOrders } from '@/modules/orders/application/maintenance';
import {
  factFromEvent,
  ProcessPaymentFact,
} from '@/modules/orders/application/process-payment-event';
import { RefundPayment } from '@/modules/orders/application/refund-payment';
import { GetTracking } from '@/modules/orders/application/queries';
import { tokenForOrder } from '@/modules/orders/domain/tracking-token';
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
import { connectTestDb, describeDb, resetDatabase, testDatabaseUrl } from './helpers';

const APP_PASSWORD = 'apppass-integration';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const LISTING = '00000000-0000-4000-8000-000000000101';
const SLUG = 'abcdefgh';

describeDb('U3: pedidos con el rol de la aplicacion (Postgres real)', () => {
  let admin: Db;
  let app: Db;
  let runner: PgTransactionRunner<AppRepos>;
  const clock = new FakeClock(Date.UTC(2026, 10, 5, 12, 0, 0));
  const payments = new MemoryPayments();
  const shipping = new MemoryShipping();
  const alerts = new RecordingAlerts();
  const logger = new MemoryLogger();

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
      'TRUNCATE order_events, orders, reservations, listing_photos, listings, payout_accounts, sender_addresses, artists, rate_limit_counters, audit_events CASCADE',
    );
    payments.sessions.clear();
    payments.refunds.clear();
    alerts.raised.length = 0;
    clock.set(Date.UTC(2026, 10, 5, 12, 0, 0));
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
    const processor = new ProcessPaymentFact({
      runner,
      clock,
      audit,
      alerts,
      logger,
      provider: payments,
    });
    const start = new StartCheckout({
      runner,
      finder: quoter,
      provider: payments,
      limiter,
      alerts,
      audit,
      clock,
      ids: new SeqIds(),
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
    return { audit, limiter, processor, start };
  };

  let n = 0;
  const begin = async (start: StartCheckout) => {
    n += 1;
    const r = unwrap(
      await start.execute(
        checkoutInput(SLUG, {
          ip: `10.1.0.${n}`,
          fields: buyerFields({ email: `c${n}@example.com` }),
        }),
      ),
    );
    expect(r.kind).toBe('redirect');
    const res = await admin.query<{ id: string; checkout_session_id: string }>(
      'SELECT id, checkout_session_id FROM orders ORDER BY created_at DESC, id DESC LIMIT 1',
    );
    return res.rows[0] as { id: string; checkout_session_id: string };
  };

  const completed = (sessionId: string) => {
    const s = payments.pay(sessionId);
    return factFromEvent(payments.eventFor(s, 'completed'))!;
  };

  const statuses = async () =>
    (
      await admin.query<{ status: string }>('SELECT status FROM orders ORDER BY created_at, id')
    ).rows.map((r) => r.status);

  // -----------------------------------------------------------------------------------------
  it('flujo completo: reserva, pedido, pago, enlace vendido y eventos sin datos personales', async () => {
    const { start, processor } = build();
    const order = await begin(start);
    expect(await statuses()).toEqual(['pendiente_pago']);
    const reservation = await admin.query('SELECT status FROM reservations WHERE listing_id = $1', [
      LISTING,
    ]);
    expect(reservation.rows[0]?.status).toBe('activa');

    await processor.execute(completed(order.checkout_session_id), 'c');
    expect(await statuses()).toEqual(['pagado']);
    const listing = await admin.query<{ status: string; order_id: string }>(
      'SELECT status, order_id FROM listings WHERE id = $1',
      [LISTING],
    );
    expect(listing.rows[0]).toEqual({ status: 'vendido', order_id: order.id });

    const events = JSON.stringify((await admin.query('SELECT * FROM order_events')).rows);
    for (const pii of ['Lucia', 'lucia@example.com', '612345678', 'Calle Sol']) {
      expect(events).not.toContain(pii);
    }
  });

  it('carrera: dos pagos del mismo enlace a la vez, gana uno y el otro va a incidencia', async () => {
    const { start, processor } = build();
    const a = await begin(start);
    // El plazo de A vence sin aviso; B reserva la obra.
    await admin.query("UPDATE orders SET expires_at = now() - interval '1 hour' WHERE id = $1", [
      a.id,
    ]);
    await admin.query("UPDATE reservations SET expires_at = now() - interval '1 hour'");
    clock.set(Date.now()); // el reloj de la prueba alcanza la fecha real de la base
    const b = await begin(start);
    await admin.query("UPDATE orders SET expires_at = now() + interval '1 hour' WHERE id = $1", [
      b.id,
    ]);

    const factA = completed(a.checkout_session_id);
    const factB = completed(b.checkout_session_id);
    await Promise.all([processor.execute(factA, 'c'), processor.execute(factB, 'c')]);

    const final = (
      await admin.query<{ status: string; refund_status: string }>(
        'SELECT status, refund_status FROM orders ORDER BY status',
      )
    ).rows;
    expect(final.map((r) => r.status).sort()).toEqual(['incidencia', 'pagado']);
    expect(final.find((r) => r.status === 'incidencia')?.refund_status).toBe('pendiente');
    const sold = await admin.query('SELECT order_id FROM listings WHERE id = $1', [LISTING]);
    const paidId = (await admin.query("SELECT id FROM orders WHERE status = 'pagado'")).rows[0]?.id;
    expect(sold.rows[0]?.order_id).toBe(paidId);
    expect(alerts.raised.some((x) => x.code === 'doble_pago')).toBe(true);
  });

  it('la misma notificacion procesada a la vez varias veces produce una sola venta', async () => {
    const { start, processor } = build();
    const order = await begin(start);
    const fact = completed(order.checkout_session_id);
    await Promise.all(Array.from({ length: 6 }, () => processor.execute(fact, 'c')));
    expect(await statuses()).toEqual(['pagado']);
    const sold = await admin.query(
      "SELECT count(*)::int AS n FROM order_events WHERE kind = 'obra_vendida'",
    );
    expect(sold.rows[0]?.n).toBe(1);
  });

  it('la base de datos impide dos pedidos pagados del mismo enlace', async () => {
    const { start, processor } = build();
    const a = await begin(start);
    await processor.execute(completed(a.checkout_session_id), 'c');
    const dup = await admin.query<{ id: string }>('SELECT id FROM orders LIMIT 1');
    await expect(
      admin.query(
        `INSERT INTO orders (id, listing_id, artist_id, status, payment_mode, snapshot, sender_address,
           effective_modality, work_price_cents, shipping_cents, total_cents, quote, consent,
           tracking_nonce, tracking_hash, token_key_id, submission_key, expires_at)
         SELECT gen_random_uuid(), listing_id, artist_id, 'pagado', payment_mode, snapshot, sender_address,
           effective_modality, work_price_cents, shipping_cents, total_cents, quote, consent,
           tracking_nonce, repeat('a', 64), token_key_id, 'otra-clave-0123456789', expires_at
         FROM orders WHERE id = $1`,
        [dup.rows[0]?.id],
      ),
    ).rejects.toThrow(/orders_one_paid_per_listing_idx/);
  });

  it('restricciones: el total debe ser obra + envio y el rol no puede borrar ni editar eventos', async () => {
    const { start } = build();
    const order = await begin(start);
    await expect(
      admin.query('UPDATE orders SET total_cents = total_cents + 1 WHERE id = $1', [order.id]),
    ).rejects.toThrow(/check/i);
    await expect(app.query('DELETE FROM order_events')).rejects.toThrow(/permission denied/i);
    await expect(app.query("UPDATE order_events SET kind = 'creado'")).rejects.toThrow(
      /permission denied/i,
    );
    await expect(app.query('DELETE FROM orders')).rejects.toThrow(/permission denied/i);
  });

  it('RLS: sin contexto no se ve nada; otra artista no ve ni escribe pedidos ajenos', async () => {
    const { start } = build();
    await begin(start);
    const none = await app.query<{ n: string }>('SELECT count(*)::text AS n FROM orders');
    expect(none.rows[0]?.n).toBe('0');
    expect(await runner.run(artistScope(B), (r) => r.orders.listByArtist(A, 10))).toEqual([]);
    expect(await runner.run(artistScope(A), (r) => r.orders.listByArtist(A, 10))).toHaveLength(1);
    // La artista no puede crear ni modificar pedidos (solo el sistema escribe).
    const mine = (await runner.run(artistScope(A), (r) => r.orders.listByArtist(A, 10)))[0]!;
    await expect(
      runner.run(artistScope(A), (r) =>
        r.orders.save({ ...mine, version: mine.version + 1, status: 'pagado' }),
      ),
    ).resolves.toBe(false);
    const stored = await admin.query('SELECT status FROM orders');
    expect(stored.rows[0]?.status).toBe('pendiente_pago');
  });

  it('concurrencia optimista: guardar con una version vieja devuelve falso', async () => {
    const { start } = build();
    await begin(start);
    const order = (
      await runner.run(systemScope, (r) => r.orders.listStripeSince(instantOf(0), 5))
    )[0]!;
    const next = { ...order, version: order.version + 1 };
    expect(await runner.run(systemScope, (r) => r.orders.save(next))).toBe(true);
    expect(await runner.run(systemScope, (r) => r.orders.save(next))).toBe(false);
  });

  it('seguimiento: encuentra por el resumen del token y no devuelve datos personales', async () => {
    const { start, limiter } = build();
    await begin(start);
    const order = (
      await runner.run(systemScope, (r) => r.orders.listStripeSince(instantOf(0), 5))
    )[0]!;
    const tracking = new GetTracking({
      runner,
      limiter,
      clock,
      secrets: SECRETS,
      manualPolicy: undefined,
    });
    const token = tokenForOrder(SECRETS, order)!;
    const view = unwrap(await tracking.execute(token, '7.7.7.7', 'c'));
    expect(JSON.stringify(view)).not.toMatch(/Lucia|lucia@|612345678|Calle Sol|08001/);
    const unknown = await tracking.execute('z'.repeat(43), '7.7.7.7', 'c');
    expect(!unknown.ok && unknown.error.code).toBe('not_found');
  });

  it('respaldo, reembolso y borrado de datos sobre la base real', async () => {
    const { start, processor, audit } = build();
    const a = await begin(start);
    await admin.query("UPDATE orders SET expires_at = now() - interval '1 hour' WHERE id = $1", [
      a.id,
    ]);
    clock.set(Date.now());
    const expire = new ExpireStaleOrders({ runner, provider: payments, processor, clock, logger });
    await expire.execute('c');
    expect(await statuses()).toEqual(['expirado']);

    const refund = new RefundPayment({ runner, provider: payments, clock, audit, alerts });
    expect(unwrap(await refund.execute(a.id, 'c', false))).toBe('nothing_to_do');

    clock.advance(31 * MS.day);
    const purge = new PurgeUnpaidOrders({ runner, clock, audit, retentionDays: 30 });
    expect((await purge.execute('c')).purged).toBe(1);
    const row = await admin.query<{ buyer: unknown; destination: unknown }>(
      'SELECT buyer, destination FROM orders',
    );
    expect(row.rows[0]).toEqual({ buyer: null, destination: null });
  });

  it('el telefono de Bizum solo lo cambia la propia artista', async () => {
    await runner.run(artistScope(A), (r) =>
      r.contacts.saveBizumPhone(A, '+34612000111', instantOf(clock.now())),
    );
    expect(await runner.run(artistScope(A), (r) => r.contacts.findBizumPhone(A))).toBe(
      '+34612000111',
    );
    await runner.run(artistScope(B), (r) =>
      r.contacts.saveBizumPhone(A, '+34699999999', instantOf(clock.now())),
    );
    const stored = await admin.query('SELECT bizum_phone FROM artists WHERE id = $1', [A]);
    expect(stored.rows[0]?.bizum_phone).toBe('+34612000111');
  });
});
