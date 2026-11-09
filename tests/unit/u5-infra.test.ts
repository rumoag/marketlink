import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { unwrap } from '@/modules/kernel/domain/result';
import { StripePayoutAdapter } from '@/modules/accounts/infrastructure/stripe-payout-adapter';
import { StripePaymentAdapter } from '@/modules/orders/infrastructure/stripe-payment-adapter';
import { StripeMoneyAdapter } from '@/modules/payouts/infrastructure/stripe-money-adapter';
import { ResilientHttpClient } from '@/modules/platform/infrastructure/http-client';
import { createResilientFetch } from '@/modules/platform/infrastructure/resilient-fetch';
import { FakeClock } from '@tests/support/generators';
import { MemoryLogger } from '@tests/support/fakes';

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

const money = (server: ReturnType<typeof fakeServer>) =>
  new StripeMoneyAdapter({
    secretKey: 'sk_test_0123456789abcdef',
    apiVersion: '2026-01-01',
    fetch: createResilientFetch(server.client, 'stripe', 'money'),
  });

describe('StripeMoneyAdapter (SDK real + cliente resiliente)', () => {
  it('transfiere ligando la transferencia al cobro, con grupo, metadatos e idempotencia', async () => {
    const server = fakeServer(() => json({ id: 'tr_1', object: 'transfer', reversed: false }));
    const r = await money(server).transfer({
      orderId: 'order-1',
      destinationAccountId: 'acct_9',
      amountCents: 25_000,
      chargeId: 'ch_1',
      idempotencyKey: 'liquidar:order-1',
    });
    expect(unwrap(r)).toEqual({ transferRef: 'tr_1' });
    const call = server.calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/transfers');
    expect(call.headers.get('idempotency-key')).toBe('liquidar:order-1');
    const form = new URLSearchParams(call.body);
    expect(form.get('amount')).toBe('25000');
    expect(form.get('currency')).toBe('eur');
    expect(form.get('destination')).toBe('acct_9');
    expect(form.get('source_transaction')).toBe('ch_1');
    expect(form.get('transfer_group')).toBe('order-1');
    expect(call.body).not.toMatch(/@|Calle/);
  });

  it('busca la transferencia del pedido por su grupo e ignora las revertidas', async () => {
    const server = fakeServer(() =>
      json({
        object: 'list',
        has_more: false,
        url: '/v1/transfers',
        data: [
          { id: 'tr_old', object: 'transfer', reversed: true, metadata: { order_id: 'o1' } },
          { id: 'tr_ok', object: 'transfer', reversed: false, metadata: { order_id: 'o1' } },
        ],
      }),
    );
    const r = await money(server).findTransfer('o1');
    expect(unwrap(r)).toEqual({ transferRef: 'tr_ok' });
    expect(server.calls[0]!.url).toContain('transfer_group=o1');
  });

  it('el pago a banco se crea en la cuenta de la artista con su clave', async () => {
    const server = fakeServer(() => json({ id: 'po_1', object: 'payout' }));
    const r = await money(server).payout({
      accountId: 'acct_9',
      amountCents: 5_000,
      idempotencyKey: 'retirar:a1:1',
      timeoutMs: 10_000,
    });
    expect(unwrap(r)).toEqual({ payoutRef: 'po_1' });
    const call = server.calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/payouts');
    expect(call.headers.get('stripe-account')).toBe('acct_9');
    expect(call.headers.get('idempotency-key')).toBe('retirar:a1:1');
    expect(new URLSearchParams(call.body).get('amount')).toBe('5000');
  });

  it('encuentra un pago por la clave guardada en sus metadatos', async () => {
    const server = fakeServer(() =>
      json({
        object: 'list',
        has_more: false,
        url: '/v1/payouts',
        data: [
          { id: 'po_x', object: 'payout', metadata: { ml_key: 'otra' } },
          { id: 'po_y', object: 'payout', metadata: { ml_key: 'retirar:a1:1' } },
        ],
      }),
    );
    expect(unwrap(await money(server).findPayout('acct_9', 'retirar:a1:1'))).toEqual({
      payoutRef: 'po_y',
    });
    expect(unwrap(await money(server).findPayout('acct_9', 'nada'))).toBeUndefined();
  });

  it('reembolsa un importe parcial con clave de idempotencia', async () => {
    const server = fakeServer(() => json({ id: 're_1', object: 'refund' }));
    const r = await money(server).refund({
      paymentIntentId: 'pi_1',
      amountCents: 400,
      idempotencyKey: 'reembolso:o1:1',
    });
    expect(unwrap(r)).toEqual({ refundRef: 're_1' });
    const call = server.calls[0]!;
    expect(call.headers.get('idempotency-key')).toBe('reembolso:o1:1');
    const form = new URLSearchParams(call.body);
    expect(form.get('payment_intent')).toBe('pi_1');
    expect(form.get('amount')).toBe('400');
  });

  it('obtiene el cobro del pago, o nada si aun no existe', async () => {
    const withCharge = fakeServer(() =>
      json({ id: 'pi_1', object: 'payment_intent', latest_charge: 'ch_77' }),
    );
    const expanded = fakeServer(() =>
      json({
        id: 'pi_2',
        object: 'payment_intent',
        latest_charge: { id: 'ch_88', object: 'charge', payment_method_details: { type: 'bizum' } },
      }),
    );
    expect(unwrap(await money(expanded).chargeOf('pi_2'))).toEqual({
      chargeId: 'ch_88',
      method: 'bizum',
    });
    expect(expanded.calls[0]?.url).toContain('expand');
    expect(unwrap(await money(withCharge).chargeOf('pi_1'))).toEqual({
      chargeId: 'ch_77',
      method: undefined,
    });
    const without = fakeServer(() =>
      json({ id: 'pi_1', object: 'payment_intent', latest_charge: null }),
    );
    expect(unwrap(await money(without).chargeOf('pi_1'))).toBeUndefined();
  });

  it('un 4xx es definitivo y un fallo de servicio es dudoso (reintentable)', async () => {
    const bad = fakeServer(() =>
      json({ error: { type: 'invalid_request_error', message: 'x' } }, 400),
    );
    const r1 = await money(bad).payout({
      accountId: 'a',
      amountCents: 1,
      idempotencyKey: 'k',
      timeoutMs: 1000,
    });
    expect(r1.ok ? undefined : r1.error.code).toBe('internal');
    const down = fakeServer(() => json({ error: { message: 'x' } }, 503));
    const r2 = await money(down).payout({
      accountId: 'a',
      amountCents: 1,
      idempotencyKey: 'k',
      timeoutMs: 1000,
    });
    expect(r2.ok ? undefined : r2.error.code).toBe('dependency_unavailable');
  });
});

describe('eventos nuevos del webhook de la plataforma', () => {
  const SECRET = 'whsec_platform_0123456789';
  const adapter = () =>
    new StripePaymentAdapter({
      secretKey: 'sk_test_0123456789abcdef',
      apiVersion: '2026-01-01',
      platformWebhookSecret: SECRET,
      fetch: createResilientFetch(fakeServer(() => json({})).client, 'stripe', 'checkout'),
    });
  const sign = (payload: string, secret = SECRET) =>
    Stripe.webhooks.generateTestHeaderString({ payload, secret });

  it('reduce charge.refunded y charge.dispute.created a lo minimo', () => {
    const refunded = JSON.stringify({
      id: 'evt_r',
      object: 'event',
      type: 'charge.refunded',
      data: {
        object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_1', amount_refunded: 400 },
      },
    });
    expect(unwrap(adapter().parseEvent(refunded, sign(refunded)))).toEqual({
      id: 'evt_r',
      type: 'charge_refunded',
      sessionId: '',
      orderId: undefined,
      paymentIntentId: 'pi_1',
      paid: false,
      amountCents: 400,
    });
    const dispute = JSON.stringify({
      id: 'evt_d',
      object: 'event',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', object: 'dispute', payment_intent: 'pi_1', amount: 25_450 } },
    });
    expect(unwrap(adapter().parseEvent(dispute, sign(dispute)))).toMatchObject({
      type: 'dispute_created',
      paymentIntentId: 'pi_1',
      amountCents: 25_450,
    });
  });

  it('la firma de los eventos nuevos tambien se verifica', () => {
    const payload = JSON.stringify({
      id: 'evt_r',
      object: 'event',
      type: 'charge.refunded',
      data: { object: { payment_intent: 'pi_1', amount_refunded: 1 } },
    });
    expect(adapter().parseEvent(payload, sign(payload, 'whsec_otro_0123456789')).ok).toBe(false);
  });
});

describe('cuentas Express con calendario manual', () => {
  const payoutAdapter = (server: ReturnType<typeof fakeServer>, manualPayouts: boolean) =>
    new StripePayoutAdapter({
      secretKey: 'sk_test_0123456789abcdef',
      apiVersion: '2026-01-01',
      connectWebhookSecret: 'whsec_test_secret_0123456789',
      fetch: createResilientFetch(server.client, 'stripe', 'api'),
      now: () => 1_700_000_000_000,
      manualPayouts,
    });

  it('con retirada manual crea la cuenta con pagos manuales; en automatico no toca el calendario', async () => {
    const manual = fakeServer(() => json({ id: 'acct_1', object: 'account' }));
    await payoutAdapter(manual, true).createAccount({
      artistId: 'a1',
      email: 'ana@example.com' as never,
    });
    expect(
      new URLSearchParams(manual.calls[0]!.body).get('settings[payouts][schedule][interval]'),
    ).toBe('manual');
    const auto = fakeServer(() => json({ id: 'acct_2', object: 'account' }));
    await payoutAdapter(auto, false).createAccount({
      artistId: 'a1',
      email: 'ana@example.com' as never,
    });
    expect(auto.calls[0]!.body).not.toContain('schedule');
  });
});
