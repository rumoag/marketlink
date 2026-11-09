import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { instantOf } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import {
  PacklinkShippingAdapter,
  parseService,
} from '@/modules/checkout/infrastructure/packlink-shipping-adapter';
import { StripePaymentAdapter } from '@/modules/orders/infrastructure/stripe-payment-adapter';
import { ResilientHttpClient } from '@/modules/platform/infrastructure/http-client';
import { createResilientFetch } from '@/modules/platform/infrastructure/resilient-fetch';
import { FakeClock } from '@tests/support/generators';
import { MemoryLogger } from '@tests/support/fakes';
import { MemoryAuditStore } from '@tests/support/fakes';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { IngestPaymentEvent } from '@/services/ingest-payment-event';

type Call = { url: string; method: string; headers: Headers; body: string };

const fakeServer = (respond: (call: Call, n: number) => Response) => {
  const calls: Call[] = [];
  const fetchFn = vi.fn((url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: String(init.method),
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : '',
    };
    calls.push(call);
    return Promise.resolve(respond(call, calls.length));
  });
  const client = new ResilientHttpClient({
    clock: new FakeClock(0),
    logger: new MemoryLogger(),
    fetch: fetchFn,
    sleep: () => Promise.resolve(),
  });
  return { calls, client };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
  });

const SECRET = 'whsec_platform_0123456789';

const stripeAdapter = (server: ReturnType<typeof fakeServer>) =>
  new StripePaymentAdapter({
    secretKey: 'sk_test_0123456789abcdef',
    apiVersion: '2026-01-01',
    platformWebhookSecret: SECRET,
    fetch: createResilientFetch(server.client, 'stripe', 'checkout'),
  });

const sessionJson = (over: Record<string, unknown> = {}) => ({
  id: 'cs_test_1',
  object: 'checkout.session',
  url: 'https://checkout.stripe.com/c/pay/cs_test_1',
  status: 'open',
  payment_status: 'unpaid',
  client_reference_id: 'order-1',
  payment_intent: null,
  amount_total: 25_450,
  metadata: { order_id: 'order-1' },
  ...over,
});

describe('StripePaymentAdapter (SDK real + cliente resiliente)', () => {
  it('crea la sesion con dos lineas, importe del servidor, caducidad y referencia, sin datos personales en metadatos', async () => {
    const server = fakeServer(() => json(sessionJson()));
    const r = await stripeAdapter(server).createCheckoutSession({
      orderId: 'order-1',
      workTitle: 'Oleo sobre lienzo',
      workPriceCents: 25_000,
      shippingCents: 450,
      customerEmail: 'lucia@example.com',
      successUrl: 'https://app.test/compra/exito?sesion={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://app.test/compra/cancelada',
      expiresAt: instantOf(1_700_001_800_000),
      methods: ['card', 'bizum'],
      idempotencyKey: 'checkout:order-1',
    });
    expect(unwrap(r)).toMatchObject({ id: 'cs_test_1', status: 'abierta', paid: false });

    const call = server.calls[0] as Call;
    expect(call.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call.headers.get('idempotency-key')).toBe('checkout:order-1');
    const form = new URLSearchParams(call.body);
    expect(form.get('mode')).toBe('payment');
    expect(form.get('client_reference_id')).toBe('order-1');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('25000');
    expect(form.get('line_items[1][price_data][unit_amount]')).toBe('450');
    expect(form.get('line_items[0][price_data][currency]')).toBe('eur');
    expect(form.get('expires_at')).toBe('1700001800');
    expect(form.get('allowed_payment_method_types[0]')).toBe('card');
    expect(form.get('allowed_payment_method_types[1]')).toBe('bizum');
    expect(form.get('success_url')).toContain('{CHECKOUT_SESSION_ID}');
    expect(form.get('metadata[order_id]')).toBe('order-1');
    // Solo el email viaja para el recibo; ni nombre ni direccion ni telefono.
    expect(call.body).not.toMatch(/Lucia|612345678|Calle/);
  });

  it('un 500 se reintenta con la misma clave de idempotencia', async () => {
    const server = fakeServer((_c, n) =>
      n === 1 ? json({ error: { message: 'x' } }, 500) : json(sessionJson()),
    );
    const r = await stripeAdapter(server).createCheckoutSession({
      orderId: 'order-1',
      workTitle: 't',
      workPriceCents: 100,
      shippingCents: 100,
      customerEmail: 'a@b.es',
      successUrl: 'https://app.test/s',
      cancelUrl: 'https://app.test/c',
      expiresAt: instantOf(1_700_001_800_000),
      methods: ['card'],
      idempotencyKey: 'checkout:order-1',
    });
    expect(r.ok).toBe(true);
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]?.headers.get('idempotency-key')).toBe('checkout:order-1');
  });

  it('caducar una sesion ya pagada devuelve su estado real en lugar de fallar', async () => {
    const paid = sessionJson({
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_1',
      url: null,
    });
    const server = fakeServer((c) =>
      c.url.endsWith('/expire')
        ? json({ error: { type: 'invalid_request_error', message: 'no' } }, 400)
        : json(paid),
    );
    const r = unwrap(await stripeAdapter(server).expireSession('cs_test_1'));
    expect(r).toMatchObject({ status: 'completada', paid: true, paymentIntentId: 'pi_1' });
  });

  it('el reembolso es idempotente: si ya existe uno no crea otro', async () => {
    const server = fakeServer((c) =>
      c.url.includes('/v1/refunds') && c.method === 'GET'
        ? json({ object: 'list', data: [{ id: 're_old', object: 'refund' }], has_more: false })
        : json({ id: 're_new', object: 'refund' }),
    );
    const r = unwrap(
      await stripeAdapter(server).refund({ paymentIntentId: 'pi_1', idempotencyKey: 'refund:o' }),
    );
    expect(r.refundId).toBe('re_old');
    expect(server.calls.every((c) => c.method === 'GET')).toBe(true);

    const fresh = fakeServer((c) =>
      c.method === 'GET'
        ? json({ object: 'list', data: [], has_more: false })
        : json({ id: 're_new', object: 'refund' }),
    );
    const created = unwrap(
      await stripeAdapter(fresh).refund({ paymentIntentId: 'pi_1', idempotencyKey: 'refund:o' }),
    );
    expect(created.refundId).toBe('re_new');
    expect(fresh.calls.at(-1)?.headers.get('idempotency-key')).toBe('refund:o');
    expect(new URLSearchParams(fresh.calls.at(-1)?.body).get('payment_intent')).toBe('pi_1');
  });

  describe('webhook de plataforma: firma verificada con el SDK real', () => {
    const event = (
      type = 'checkout.session.completed',
      session = sessionJson({ status: 'complete', payment_status: 'paid', payment_intent: 'pi_1' }),
    ) => ({
      id: 'evt_1',
      object: 'event',
      type,
      created: 1_700_000_100,
      data: { object: session },
    });
    const sign = (payload: string, secret = SECRET) =>
      Stripe.webhooks.generateTestHeaderString({ payload, secret });
    const adapter = () => stripeAdapter(fakeServer(() => json({})));

    it('acepta una firma valida y reduce el evento sin datos personales', () => {
      const payload = JSON.stringify(event());
      const parsed = unwrap(adapter().parseEvent(payload, sign(payload)));
      expect(parsed).toEqual({
        id: 'evt_1',
        type: 'completed',
        sessionId: 'cs_test_1',
        orderId: 'order-1',
        paymentIntentId: 'pi_1',
        paid: true,
        amountCents: 25_450,
      });
    });

    it('rechaza firmas invalidas, secretos de otro endpoint y cuerpos manipulados', () => {
      const payload = JSON.stringify(event());
      expect(adapter().parseEvent(payload, sign(payload, 'whsec_connect_otro_0123456789')).ok).toBe(
        false,
      );
      expect(adapter().parseEvent(payload, '').ok).toBe(false);
      expect(adapter().parseEvent(`${payload} `, sign(payload)).ok).toBe(false);
    });

    it('trata expirada y pago asincrono; ignora otros tipos', () => {
      const exp = JSON.stringify(
        event('checkout.session.expired', sessionJson({ status: 'expired' })),
      );
      expect(unwrap(adapter().parseEvent(exp, sign(exp)))).toMatchObject({
        type: 'expired',
        paid: false,
      });
      const asyncOk = JSON.stringify(event('checkout.session.async_payment_succeeded'));
      expect(unwrap(adapter().parseEvent(asyncOk, sign(asyncOk)))).toMatchObject({
        type: 'async_succeeded',
        paid: true,
      });
      const other = JSON.stringify(event('customer.created'));
      expect(unwrap(adapter().parseEvent(other, sign(other)))).toBeNull();
    });

    it('la ingesta guarda una vez, encola una vez y rechaza la firma mala con auditoria', async () => {
      const seen = new Set<string>();
      const enqueued: string[] = [];
      const audit = new MemoryAuditStore();
      const logger = new MemoryLogger();
      const ingest = new IngestPaymentEvent({
        provider: adapter(),
        store: {
          insertIfNew: (_p, id) => {
            const isNew = !seen.has(id);
            seen.add(id);
            return Promise.resolve(isNew);
          },
        },
        enqueue: (job) => {
          enqueued.push(job.dedupeKey);
          return Promise.resolve();
        },
        audit: new AuditLog(audit, logger, new FakeClock(0)),
        logger,
      });
      const payload = JSON.stringify(event());
      expect(await ingest.handle(payload, sign(payload), 'c')).toBe('accepted');
      expect(await ingest.handle(payload, sign(payload), 'c')).toBe('duplicate');
      expect(enqueued).toEqual(['stripe-event:evt_1']);
      expect(await ingest.handle(payload, 'mala', 'c')).toBe('invalid_signature');
      expect(audit.events.at(-1)?.action).toBe('webhook_signature_invalid');
    });
  });
});

describe('PacklinkShippingAdapter (cliente resiliente)', () => {
  const adapter = (server: ReturnType<typeof fakeServer>) =>
    new PacklinkShippingAdapter({
      apiKey: 'pk_test_0123456789',
      fetch: createResilientFetch(server.client, 'packlink', 'quote', {
        timeoutMs: 5_000,
        maxRetries: 1,
      }),
    });
  const request = {
    fromPostalCode: '28001',
    toPostalCode: '08001',
    parcel: { lengthCm: 50, widthCm: 40, heightCm: 10, weightKg: 2 },
    declaredValueCents: 25_000,
  };
  const svc = (over: Record<string, unknown> = {}) => ({
    id: 20001,
    carrier_name: 'Correos',
    name: 'Paq Estandar',
    dropoff: true,
    transit_hours: '48',
    price: { total_price: 4.5, base_price: 3.7, currency: 'EUR' },
    ...over,
  });

  it('pide los servicios con la clave, el origen, el destino y el paquete; convierte a centimos', async () => {
    const server = fakeServer(() =>
      json([svc(), svc({ id: 2, dropoff: false, price: { total_price: 6.2 } })]),
    );
    const r = unwrap(await adapter(server).quote(request));
    expect(r).toEqual([
      {
        id: '20001',
        name: 'Correos Paq Estandar',
        modality: 'punto',
        priceCents: 450,
        transitDays: 2,
      },
      {
        id: '2',
        name: 'Correos Paq Estandar',
        modality: 'recogida',
        priceCents: 620,
        transitDays: 2,
      },
    ]);
    const call = server.calls[0] as Call;
    expect(call.method).toBe('GET');
    expect(call.headers.get('authorization')).toBe('pk_test_0123456789');
    const q = new URL(call.url).searchParams;
    expect(q.get('from[zip]')).toBe('28001');
    expect(q.get('to[zip]')).toBe('08001');
    expect(q.get('packages[0][weight]')).toBe('2');
    expect(call.url).not.toContain('Lucia');
  });

  it('descarta servicios con precio invalido y un cuerpo que no es una lista cuenta como proveedor caido', async () => {
    const bad = [
      svc({ price: { total_price: 0 } }),
      svc({ price: { total_price: 'x' } }),
      svc({ price: { total_price: 500 } }),
      7,
      null,
    ];
    expect(unwrap(await adapter(fakeServer(() => json(bad))).quote(request))).toEqual([]);
    const notList = await adapter(fakeServer(() => json({ error: 'x' }))).quote(request);
    expect(notList.ok).toBe(false);
    expect(parseService(undefined)).toBeUndefined();
  });

  it('un 500 se reintenta una vez (maximo dos intentos) y un 401 cuenta como fallo sin reintento', async () => {
    const flaky = fakeServer((_c, n) => (n === 1 ? json({}, 503) : json([svc()])));
    expect((await adapter(flaky).quote(request)).ok).toBe(true);
    expect(flaky.calls).toHaveLength(2);
    const down = fakeServer(() => json({}, 503));
    expect((await adapter(down).quote(request)).ok).toBe(false);
    expect(down.calls).toHaveLength(2);
    const unauthorized = fakeServer(() => json({}, 401));
    expect((await adapter(unauthorized).quote(request)).ok).toBe(false);
    expect(unauthorized.calls).toHaveLength(1);
  });
});
