import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { instantOf, MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { QuoteShipping } from '@/modules/checkout/application/quote-shipping';
import { StartCheckout } from '@/modules/checkout/application/start-checkout';
import {
  factFromEvent,
  ProcessPaymentFact,
} from '@/modules/orders/application/process-payment-event';
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

describeDb('U4: envios y notificaciones con el rol de la aplicacion (Postgres real)', () => {
  let admin: Db;
  let app: Db;
  let runner: PgTransactionRunner<AppRepos>;
  const clock = new FakeClock(Date.UTC(2026, 10, 6, 12, 0, 0));
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
      'TRUNCATE order_events, orders, reservations, listing_photos, listings, payout_accounts, sender_addresses, artists, rate_limit_counters, audit_events CASCADE',
    );
    payments.sessions.clear();
    provider.drafts.clear();
    provider.createCalls = 0;
    provider.created = 0;
    labels.objects.clear();
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
    const quoter = new QuoteShipping({ runner, shipping, limiter, alerts, clock, logger });
    const onPaid = new OnOrderPaid({
      runner,
      clock,
      ids,
      enqueueDraft: () => Promise.resolve(),
    });
    const processor = new ProcessPaymentFact({
      runner,
      clock,
      audit,
      alerts,
      logger,
      provider: payments,
      onPaid: (id) => onPaid.execute(id),
    });
    const start = new StartCheckout({
      runner,
      quoter,
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
    });
    return { processor, start, draft, processFact, audit };
  };

  /** Compra pagada y borrador creado; devuelve el pedido y la referencia de Packlink. */
  const shipped = async () => {
    const { start, processor, draft } = build();
    unwrap(
      await start.execute(
        checkoutInput(SLUG, { fields: buyerFields({ email: 'c@example.com' }), ip: '10.2.0.1' }),
      ),
    );
    const o = (
      await admin.query<{ id: string; checkout_session_id: string }>(
        'SELECT id, checkout_session_id FROM orders',
      )
    ).rows[0]!;
    const s = payments.pay(o.checkout_session_id);
    await processor.execute(factFromEvent(payments.eventFor(s, 'completed'))!, 'c');
    unwrap(await draft.execute(o.id, 'c', false));
    const ref = (await admin.query<{ provider_ref: string }>('SELECT provider_ref FROM shipments'))
      .rows[0]!.provider_ref;
    return { orderId: o.id, ref };
  };

  const status = async () =>
    (await admin.query<{ status: string }>('SELECT status FROM orders')).rows[0]?.status;
  const notes = async () =>
    (
      await admin.query<{ type: string; n: string }>(
        'SELECT type, count(*)::text AS n FROM notifications GROUP BY type ORDER BY type',
      )
    ).rows.map((r) => `${r.type}:${r.n}`);

  // -----------------------------------------------------------------------------------------
  it('flujo completo: pago, avisos, borrador, etiqueta, transito y entrega', async () => {
    const { ref } = await shipped();
    expect(await status()).toBe('borrador_creado');
    const { processFact } = build();
    const t = clock.now();
    await processFact.execute(ref, fact('label_ready', t), 'c');
    expect(await status()).toBe('etiqueta_lista');
    await processFact.execute(ref, fact('in_transit', t + 1), 'c');
    await processFact.execute(ref, fact('delivered', t + 2, { labelCostCents: 520 }), 'c');
    expect(await status()).toBe('entregado');
    expect(await notes()).toEqual([
      'confirmacion_compradora:1',
      'en_camino_compradora:1',
      'entregado_artista:1',
      'entregado_compradora:1',
      'etiqueta_lista_artista:1',
      'paga_envio_operador:1',
      'pedido_nuevo_artista:1',
    ]);
    const o = (
      await admin.query<{ label_cost_cents: number; margin_cents: number }>(
        'SELECT label_cost_cents, margin_cents FROM orders',
      )
    ).rows[0]!;
    expect(o.label_cost_cents).toBe(520);
    expect(o.margin_cents).toBe(450 - 520 - (Math.round(25_450 * 0.015) + 25));
  });

  it('hechos concurrentes, repetidos y desordenados: estado final correcto y un solo aviso por tipo', async () => {
    const { ref } = await shipped();
    const { processFact } = build();
    const t = clock.now();
    const facts = [
      fact('delivered', t + 3),
      fact('label_ready', t + 1),
      fact('in_transit', t + 2),
      fact('label_ready', t + 1),
      fact('delivered', t + 3),
      fact('in_transit', t + 2),
      fact('tracking_info', t, { trackingUrl: 'https://carrier.test/x' }),
      fact('label_ready', t + 1),
    ];
    await Promise.all(facts.map((f) => processFact.execute(ref, f, 'c')));
    expect(await status()).toBe('entregado');
    const counts = await notes();
    // La entrega se avisa exactamente una vez; los estados intermedios, como mucho una (si un
    // hecho posterior llega antes, el anterior ya no cambia nada y no genera aviso).
    expect(counts).toContain('entregado_artista:1');
    expect(counts).toContain('entregado_compradora:1');
    for (const type of ['en_camino_compradora', 'etiqueta_lista_artista']) {
      expect(counts.filter((c) => c.startsWith(type) && c !== `${type}:1`)).toEqual([]);
    }
    // Cada cambio de estado queda registrado una sola vez (el reloj de la prueba es fijo, asi que
    // aqui no se comprueba el orden temporal; eso lo cubren las propiedades P-U4-01 a P-U4-03).
    const events = (
      await admin.query<{ kind: string }>(
        "SELECT kind FROM order_events WHERE kind IN ('borrador_creado','etiqueta_lista','en_transito','entregado')",
      )
    ).rows.map((r) => r.kind);
    expect(new Set(events).size).toBe(events.length);
    expect(events).toContain('entregado');
  });

  it('un solo envio por pedido aunque el borrador se pida varias veces a la vez', async () => {
    const { start, processor, draft } = build();
    unwrap(await start.execute(checkoutInput(SLUG, { ip: '10.2.0.9' })));
    const o = (
      await admin.query<{ id: string; checkout_session_id: string }>(
        'SELECT id, checkout_session_id FROM orders',
      )
    ).rows[0]!;
    await processor.execute(
      factFromEvent(payments.eventFor(payments.pay(o.checkout_session_id), 'completed'))!,
      'c',
    );
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => draft.execute(o.id, 'c', false)),
    );
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    const ships = await admin.query('SELECT 1 FROM shipments');
    expect(ships.rowCount).toBe(1);
    expect(await status()).toBe('borrador_creado');
    expect((await notes()).filter((n) => n.startsWith('paga_envio_operador'))).toEqual([
      'paga_envio_operador:1',
    ]);
  });

  it('claimDue / claimDueForPolling reparten el trabajo sin solaparse', async () => {
    const { ref } = await shipped();
    const t = clock.now() + 20 * MS.minute;
    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        runner.run(systemScope, (r) =>
          r.shipments.claimDueForPolling(instantOf(t), 10, 5 * MS.minute),
        ),
      ),
    );
    const total = claims.flat();
    expect(total).toHaveLength(1);
    expect(total[0]?.providerRef).toBe(ref);

    const nclaims = await Promise.all(
      Array.from({ length: 4 }, () =>
        runner.run(systemScope, (r) => r.notifications.claimDue(instantOf(t), 10, 5 * MS.minute)),
      ),
    );
    const claimed = nclaims.flat();
    expect(new Set(claimed.map((n) => n.id)).size).toBe(claimed.length);
    expect(claimed.length).toBe(3); // pedido nuevo, confirmacion y paga el envio
  });

  it('notificaciones unicas por pedido y tipo: insertar de nuevo no duplica', async () => {
    await shipped();
    const existing = (
      await admin.query<{ order_id: string }>('SELECT order_id FROM notifications LIMIT 1')
    ).rows[0]?.order_id;
    const n = await runner.run(systemScope, (r) =>
      r.notifications.insertMany([
        {
          id: '00000000-0000-4000-8000-0000000000aa',
          orderId: existing as string,
          artistId: A,
          type: 'pedido_nuevo_artista',
          recipientRole: 'artista',
          status: 'pendiente',
          attempts: 0,
          nextAttemptAt: clock.now(),
          lastError: undefined,
          createdAt: clock.now(),
          sentAt: undefined,
        },
      ]),
    );
    expect(n).toBe(0);
  });

  it('RLS: sin contexto no se ve nada; otra artista no ve ni escribe envios ni notificaciones ajenos', async () => {
    await shipped();
    const none = await app.query<{ n: string }>('SELECT count(*)::text AS n FROM shipments');
    expect(none.rows[0]?.n).toBe('0');
    const none2 = await app.query<{ n: string }>('SELECT count(*)::text AS n FROM notifications');
    expect(none2.rows[0]?.n).toBe('0');

    const orderId = (await admin.query<{ id: string }>('SELECT id FROM orders')).rows[0]!.id;
    expect(
      await runner.run(artistScope(B), (r) => r.shipments.findByOrder(orderId)),
    ).toBeUndefined();
    expect(await runner.run(artistScope(B), (r) => r.notifications.listFailedByArtist(A))).toEqual(
      [],
    );
    const mine = await runner.run(artistScope(A), (r) => r.shipments.findByOrder(orderId));
    expect(mine?.orderId).toBe(orderId);

    // La artista no puede modificar su envio: solo el sistema escribe.
    await runner.run(artistScope(A), (r) =>
      r.shipments.save({ ...(mine as NonNullable<typeof mine>), status: 'entregado' }),
    );
    expect((await admin.query('SELECT status FROM shipments')).rows[0]?.status).toBe('borrador');
  });

  it('el rol de la aplicacion no puede borrar envios ni pedidos; las restricciones se cumplen', async () => {
    await shipped();
    await expect(app.query('DELETE FROM shipments')).rejects.toThrow(/permission denied/i);
    await expect(admin.query("UPDATE shipments SET status = 'inventado'")).rejects.toThrow(
      /check/i,
    );
    await expect(admin.query("UPDATE notifications SET type = 'otro'")).rejects.toThrow(/check/i);
  });

  it('retencion: la limpieza borra notificaciones antiguas y deja las recientes', async () => {
    await shipped();
    await admin.query(
      "UPDATE notifications SET created_at = now() - interval '13 months' WHERE type = 'pedido_nuevo_artista'",
    );
    const deleted = await runner.run(systemScope, (r) =>
      r.notifications.deleteOlderThan(instantOf(Date.now() - 365 * MS.day)),
    );
    expect(deleted).toBe(1);
    expect((await notes()).some((n) => n.startsWith('pedido_nuevo_artista'))).toBe(false);
    expect((await notes()).length).toBeGreaterThan(0);
  });
});
