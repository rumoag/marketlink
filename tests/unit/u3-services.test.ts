import { describe, expect, it } from 'vitest';
import { unwrap } from '@/modules/kernel/domain/result';
import { MS } from '@/modules/kernel/domain/clock';
import { tokenForOrder } from '@/modules/orders/domain/tracking-token';
import type { Order } from '@/modules/orders/domain/order';
import {
  SECRETS,
  buildU3,
  buyerFields,
  checkoutInput,
  factFromEvent,
  nextKey,
  sellableListing,
  type U3,
} from '@tests/support/u3-harness';
import { artistScope } from '@/modules/platform/application/unit-of-work';

const orders = (u: U3): Order[] => [...u.db.state.orders.values()];
const only = (u: U3): Order => {
  const all = orders(u);
  expect(all).toHaveLength(1);
  return all[0] as Order;
};
const listingOf = (u: U3, order: Order) => u.db.state.listings.get(order.listingId);

const start = async (u: U3, slug: string, over = {}) =>
  unwrap(await u.startCheckout.execute(checkoutInput(slug, over)));

/** La compradora paga y llega el aviso de Stripe. */
const payAndNotify = async (u: U3, order: Order) => {
  const session = u.payments.pay(order.checkoutSessionId as string);
  const fact = factFromEvent(u.payments.eventFor(session, 'completed'));
  return u.processor.execute(fact!, 'c');
};

describe('U3 cotizar envio (US-017 a US-019)', () => {
  it('elige el servicio mas barato de la modalidad del enlace', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    const r = unwrap(await u.quote.execute(slug, '08001', '1.1.1.1', 'c'));
    expect(r.kind).toBe('cotizacion');
    if (r.kind === 'cotizacion' && r.quote.kind === 'disponible') {
      expect(r.quote.service.id).toBe('p-b');
      expect(r.quote.totals.totalCents).toBe(25_450);
    } else throw new Error('esperaba disponible');
  });

  it('ofrece la otra modalidad si no hay servicio de la del enlace', async () => {
    const u = buildU3();
    u.shipping.services = u.shipping.services.filter((s) => s.modality === 'recogida');
    const { slug } = await sellableListing(u);
    const r = unwrap(await u.quote.execute(slug, '08001', '1.1.1.1', 'c'));
    expect(r.kind === 'cotizacion' && r.quote.kind).toBe('solo_alternativa');
  });

  it('proveedor caido: sin envio y aviso al operador (una sola vez por enlace y codigo postal)', async () => {
    const u = buildU3();
    u.shipping.fail = true;
    const { slug } = await sellableListing(u);
    for (let i = 0; i < 3; i++) {
      const r = unwrap(await u.quote.execute(slug, '08001', '1.1.1.1', 'c'));
      expect(r.kind === 'cotizacion' && r.quote.kind).toBe('sin_envio');
    }
    expect(u.alerts.raised.filter((a) => a.code === 'packlink_no_disponible')).toHaveLength(1);
  });

  it('rechaza codigos postales fuera de la peninsula y limita por IP', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    const bad = await u.quote.execute(slug, '07001', '1.1.1.1', 'c');
    expect(!bad.ok && bad.error.code).toBe('validation');
    let last = bad;
    for (let i = 0; i < 25; i++) last = await u.quote.execute(slug, '08001', '2.2.2.2', 'c');
    expect(!last.ok && last.error.code).toBe('rate_limited');
  });
});

describe('U3 iniciar el pago y vender (US-020, US-022, US-025)', () => {
  it('flujo completo: reserva, pedido pendiente, pago confirmado, enlace vendido', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    const r = await start(u, slug);
    expect(r.kind).toBe('redirect');
    const order = only(u);
    expect(order.status).toBe('pendiente_pago');
    expect(order.totalCents).toBe(25_450);
    expect(order.workPriceCents + order.shippingCents).toBe(order.totalCents);
    expect(listingOf(u, order)?.status).toBe('activo');

    // Mientras se paga, otra compradora ve la obra reservada.
    const second = await start(u, slug, { fields: buyerFields({ email: 'otra@example.com' }) });
    expect(second).toEqual({ kind: 'obra_no_disponible', reason: 'reservado' });

    const out = await payAndNotify(u, order);
    expect(out.kind).toBe('applied');
    const paid = only(u);
    expect(paid.status).toBe('pagado');
    expect(listingOf(u, paid)?.status).toBe('vendido');
    expect(listingOf(u, paid)?.orderId).toBe(paid.id);
    expect(u.db.state.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['creado', 'pago_iniciado', 'pago_confirmado', 'obra_vendida']),
    );
  });

  it('el mismo aviso repetido no cambia nada (idempotencia)', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await start(u, slug);
    const order = only(u);
    await payAndNotify(u, order);
    const events = u.db.state.events.length;
    const again = await u.processor.execute(
      factFromEvent(
        u.payments.eventFor(u.payments.sessions.get(order.checkoutSessionId!) as never),
      )!,
      'c',
    );
    expect(again.kind).toBe('unchanged');
    expect(u.db.state.events).toHaveLength(events);
  });

  it('el total esperado distinto no crea pedido ni reserva y devuelve el total real', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    const r = await start(u, slug, { expectedTotalCents: 100 });
    expect(r.kind).toBe('total_changed');
    expect(orders(u)).toHaveLength(0);
    expect(u.db.state.reservations.size).toBe(0);
  });

  it('exige aceptar las condiciones y valida la compradora', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    const a = await u.startCheckout.execute(checkoutInput(slug, { acceptTerms: false }));
    expect(!a.ok && a.error.code).toBe('validation');
    const b = await u.startCheckout.execute(
      checkoutInput(slug, { fields: buyerFields({ postalCode: '28001', province: 'Barcelona' }) }),
    );
    expect(!b.ok && b.error.details?.some((d) => d.field === 'province')).toBe(true);
    expect(orders(u)).toHaveLength(0);
  });

  it('doble clic con la misma clave devuelve el mismo pago, no un segundo pedido', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    const input = checkoutInput(slug);
    const first = unwrap(await u.startCheckout.execute(input));
    const second = unwrap(await u.startCheckout.execute(input));
    expect(first.kind).toBe('redirect');
    expect(second.kind).toBe('existing_open');
    expect(orders(u)).toHaveLength(1);
  });

  it('Stripe caido: todo o nada, sin reserva colgada', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    u.payments.failCreate = true;
    const r = await start(u, slug);
    expect(r.kind).toBe('provider_error');
    expect(only(u).status).toBe('cancelado');
    u.payments.failCreate = false;
    expect((await start(u, slug)).kind).toBe('redirect');
  });

  it('sin envio posible no se puede pagar', async () => {
    const u = buildU3();
    u.shipping.services = [];
    const { slug } = await sellableListing(u);
    expect((await start(u, slug)).kind).toBe('no_shipping');
    expect(orders(u)).toHaveLength(0);
  });

  it('la alternativa exige aceptacion explicita', async () => {
    const u = buildU3();
    u.shipping.services = u.shipping.services.filter((s) => s.modality === 'recogida');
    const { slug } = await sellableListing(u);
    const first = await start(u, slug, { expectedTotalCents: 25_620 });
    expect(first.kind).toBe('alternative_required');
    const ok = await start(u, slug, { expectedTotalCents: 25_620, acceptedAlternative: true });
    expect(ok.kind).toBe('redirect');
    expect(only(u).alternativeAccepted).toBe(true);
    expect(only(u).effectiveModality).toBe('recogida');
  });

  it('limita las reservas por IP (5 por hora)', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    let last = await u.startCheckout.execute(checkoutInput(slug, { expectedTotalCents: 1 }));
    for (let i = 0; i < 5; i++) {
      last = await u.startCheckout.execute(checkoutInput(slug, { expectedTotalCents: 1 }));
    }
    expect(!last.ok && last.error.code).toBe('rate_limited');
  });
});

describe('U3 expirar, cancelar y reintentar', () => {
  it('el aviso de sesion caducada expira el pedido y libera la reserva', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await start(u, slug);
    const order = only(u);
    const session = u.payments.sessions.get(order.checkoutSessionId!) as never;
    const fact = factFromEvent(u.payments.eventFor(session, 'expired'))!;
    await u.processor.execute(fact, 'c');
    expect(only(u).status).toBe('expirado');
    expect((await start(u, slug)).kind).toBe('redirect'); // la obra se puede volver a reservar
  });

  it('el respaldo por reloj cierra pedidos vencidos y recupera un pago que no llego', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await start(u, slug);
    const order = only(u);
    u.clock.advance(40 * MS.minute);
    await u.expire.execute('c');
    expect(only(u).status).toBe('expirado');

    // Otro pedido pagado en Stripe sin aviso: el respaldo lo recupera.
    const u2 = buildU3();
    const l2 = await sellableListing(u2);
    await start(u2, l2.slug);
    const o2 = only(u2);
    u2.payments.pay(o2.checkoutSessionId!);
    u2.clock.advance(40 * MS.minute);
    await u2.expire.execute('c');
    expect(only(u2).status).toBe('pagado');
    expect(order.status).toBe('pendiente_pago'); // el primer arnes no cambio
  });

  it('cancelar con la cookie libera la reserva y rellena el formulario sin la aceptacion', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    const r = await start(u, slug);
    if (r.kind !== 'redirect') throw new Error('redirect');
    const out = await u.cancel.execute(r.resumeId, 'c');
    expect(out.kind).toBe('cancelled');
    expect(only(u).status).toBe('cancelado');
    const form = await u.cancel.consumeForm(r.resumeId, slug);
    expect(form?.fields.name).toBe('Lucia Garcia');
    expect(form?.fields).not.toHaveProperty('acceptTerms');
    expect(await u.cancel.consumeForm(r.resumeId, slug)).toBeUndefined(); // un solo uso
    expect((await start(u, slug)).kind).toBe('redirect');
  });

  it('cancelar un pedido ya pagado va a exito y no cancela', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    const r = await start(u, slug);
    if (r.kind !== 'redirect') throw new Error('redirect');
    u.payments.pay(only(u).checkoutSessionId!);
    const out = await u.cancel.execute(r.resumeId, 'c');
    expect(out.kind).toBe('paid');
    expect(only(u).status).toBe('pagado');
  });

  it('la cookie caducada o inventada no hace nada', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    const r = await start(u, slug);
    if (r.kind !== 'redirect') throw new Error('redirect');
    u.clock.advance(61 * MS.minute);
    expect((await u.cancel.execute(r.resumeId, 'c')).kind).toBe('none');
    expect((await u.cancel.execute('x'.repeat(22), 'c')).kind).toBe('none');
  });
});

describe('U3 doble pago y pago tardio (US-022)', () => {
  it('un pago tardio con la obra ya vendida a otro pedido se reembolsa solo', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await start(u, slug);
    const a = only(u);
    u.clock.advance(40 * MS.minute);
    await u.expire.execute('c'); // A expira sin pagar
    await start(u, slug, { fields: buyerFields({ email: 'b@example.com' }) });
    const b = orders(u).find((o) => o.id !== a.id) as Order;
    await payAndNotify(u, b); // B gana
    // El pago de A llega tarde.
    const lateSession = u.payments.pay(a.checkoutSessionId!);
    const out = await u.processor.execute(
      factFromEvent(u.payments.eventFor(lateSession, 'completed'))!,
      'c',
    );
    expect(out).toMatchObject({ kind: 'applied', needsRefund: true });
    expect(u.db.state.orders.get(a.id)?.status).toBe('incidencia');
    expect(u.alerts.raised.some((x) => x.code === 'doble_pago')).toBe(true);

    expect(unwrap(await u.refund.execute(a.id, 'c', false))).toBe('done');
    expect(u.db.state.orders.get(a.id)?.status).toBe('reembolsado');
    expect(u.db.state.orders.get(b.id)?.status).toBe('pagado');
    expect(u.payments.refunds.size).toBe(1);
    // Reintentar no crea un segundo reembolso.
    expect(unwrap(await u.refund.execute(a.id, 'c', false))).toBe('nothing_to_do');
    expect(u.payments.refunds.size).toBe(1);
  });

  it('un pago tardio con la obra aun libre se acepta', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await start(u, slug);
    const a = only(u);
    u.clock.advance(40 * MS.minute);
    await u.expire.execute('c');
    expect(only(u).status).toBe('expirado');
    await payAndNotify(u, a);
    expect(only(u).status).toBe('pagado');
    expect(listingOf(u, a)?.status).toBe('vendido');
  });

  it('un reembolso que falla en el ultimo intento queda marcado y avisa', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await start(u, slug);
    const a = only(u);
    u.clock.advance(40 * MS.minute);
    await u.expire.execute('c');
    await start(u, slug, { fields: buyerFields({ email: 'b@example.com' }) });
    const b = orders(u).find((o) => o.id !== a.id) as Order;
    await payAndNotify(u, b);
    await u.processor.execute(
      factFromEvent(u.payments.eventFor(u.payments.pay(a.checkoutSessionId!), 'completed'))!,
      'c',
    );
    u.payments.failRefund = true;
    const r = await u.refund.execute(a.id, 'c', true);
    expect(r.ok).toBe(false);
    expect(u.db.state.orders.get(a.id)?.refundStatus).toBe('fallido');
    expect(u.alerts.raised.some((x) => x.code === 'reembolso_fallido')).toBe(true);
  });
});

describe('U3 seguimiento y privacidad (US-023)', () => {
  it('la pagina de exito entrega el token y el seguimiento no tiene datos personales', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await start(u, slug);
    const order = only(u);
    await payAndNotify(u, order);

    const success = unwrap(await u.success.execute(order.checkoutSessionId!, '1.1.1.1', 'c'));
    expect(success.status).toBe('pagado');
    const token = success.trackingToken!;
    expect(token).toBe(tokenForOrder(SECRETS, order));

    const view = unwrap(await u.tracking.execute(token, '1.1.1.1', 'c'));
    const text = JSON.stringify(view);
    for (const secret of ['Lucia', 'lucia@example.com', '612345678', 'Calle Sol', '08001']) {
      expect(text).not.toContain(secret);
    }
    expect(view.statusText).toMatch(/Pago recibido/);
  });

  it('un token alterado, inventado o mal formado da la misma respuesta generica', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await start(u, slug);
    const order = only(u);
    const good = tokenForOrder(SECRETS, order)!;
    const altered = `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`;
    const replies = await Promise.all(
      [altered, 'z'.repeat(43), 'corto', ''].map((t) => u.tracking.execute(t, '1.1.1.1', 'c')),
    );
    for (const r of replies) expect(!r.ok && r.error.code).toBe('not_found');
    expect((await u.tracking.execute(good, '1.1.1.1', 'c')).ok).toBe(true);
  });

  it('eventos, auditoria y trabajos no contienen datos personales', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await start(u, slug);
    await payAndNotify(u, only(u));
    const dump = JSON.stringify([u.db.state.events, u.auditStore.events]);
    for (const secret of ['Lucia', 'lucia@example.com', '612345678', 'Calle Sol']) {
      expect(dump).not.toContain(secret);
    }
  });

  it('borra los datos personales de pedidos no pagados pasados 30 dias', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await start(u, slug);
    u.clock.advance(40 * MS.minute);
    await u.expire.execute('c');
    u.clock.advance(31 * MS.day);
    expect((await u.purge.execute('c')).purged).toBe(1);
    const o = only(u);
    expect(o.buyer).toBeUndefined();
    expect(o.destination).toBeUndefined();
    expect((await u.purge.execute('c')).purged).toBe(0);
  });
});

describe('U3 conciliacion', () => {
  it('avisa de un pago de Stripe sin pedido pagado y no corrige nada', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await start(u, slug);
    const order = only(u);
    u.payments.pay(order.checkoutSessionId!); // pagado en Stripe, aviso perdido
    const res = await u.reconcile.execute('c');
    expect(res.mismatches).toBe(1);
    expect(u.alerts.raised.some((a) => a.code === 'conciliacion_desajuste')).toBe(true);
    expect(only(u).status).toBe('pendiente_pago');
  });
});

describe('U3 modo manual (US-024)', () => {
  it('con el flag apagado no existe', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    const r = await u.startCheckout.execute(checkoutInput(slug, { method: 'manual' }));
    expect(!r.ok && r.error.code).toBe('not_found');
    const c = await u.confirmManual.execute('a', 'b', 'c');
    expect(!c.ok && c.error.code).toBe('not_found');
  });

  it('la artista confirma el cobro; otra artista no puede', async () => {
    const u = buildU3({ manual: true });
    const { slug, artistId } = await sellableListing(u);
    await u.db.run({ kind: 'system' }, (r) =>
      r.contacts.saveBizumPhone(artistId, '+34612000111', u.clock.now()),
    );
    const r = unwrap(await u.startCheckout.execute(checkoutInput(slug, { method: 'manual' })));
    expect(r.kind).toBe('manual');
    const order = only(u);
    expect(order.paymentMode).toBe('manual');

    const view = unwrap(
      await u.tracking.execute((r as { trackingToken: string }).trackingToken, '1.1.1.1', 'c'),
    );
    expect(view.manual?.bizumPhone).toBe('+34612000111');

    const other = await u.confirmManual.execute(
      '00000000-0000-4000-8000-0000000000ff',
      order.id,
      'c',
    );
    expect(!other.ok && other.error.code).toBe('not_found');
    expect(only(u).status).toBe('pendiente_pago');

    expect((await u.confirmManual.execute(artistId, order.id, 'c')).ok).toBe(true);
    expect(only(u).status).toBe('pagado');
    expect(listingOf(u, only(u))?.status).toBe('vendido');
    expect((await u.confirmManual.execute(artistId, order.id, 'c')).ok).toBe(true); // idempotente

    const rows = await u.artistOrders.execute(artistId);
    expect(rows).toHaveLength(1);
  });

  it('sin telefono de Bizum la obra no admite el modo manual', async () => {
    const u = buildU3({ manual: true });
    const { slug } = await sellableListing(u);
    const r = await u.startCheckout.execute(checkoutInput(slug, { method: 'manual' }));
    expect(!r.ok && r.error.code).toBe('conflict');
  });
});

describe('U3 autorizacion por objeto', () => {
  it('una artista solo ve los pedidos de sus enlaces', async () => {
    const u = buildU3();
    const { slug, artistId } = await sellableListing(u);
    await start(u, slug);
    const other = await u.db.run(artistScope('00000000-0000-4000-8000-0000000000ee'), (r) =>
      r.orders.listByArtist(artistId, 10),
    );
    expect(other).toHaveLength(0);
    expect(nextKey()).toBeTruthy();
  });
});
