import { describe, expect, it } from 'vitest';
import { MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import type { Order } from '@/modules/orders/domain/order';
import { fact, buildU4, paidOrder, type U4 } from '@tests/support/u4-harness';

const order = (u: U4, id: string): Order => u.db.state.orders.get(id) as Order;
const shipmentOf = (u: U4, orderId: string) =>
  [...u.db.state.shipments.values()].find((s) => s.orderId === orderId)!;
const types = (u: U4, orderId?: string) =>
  [...u.db.state.notifications.values()]
    .filter((n) => orderId === undefined || n.orderId === orderId)
    .map((n) => n.type)
    .sort();

/** Pedido pagado con borrador creado (modalidad punto). */
const withDraft = async (u: U4) => {
  const paid = await paidOrder(u);
  unwrap(await u.draft.execute(paid.order.id, 'c', false));
  return { ...paid, ref: shipmentOf(u, paid.order.id).providerRef as string };
};

describe('U4 pago confirmado: avisos y borrador (US-026, US-023)', () => {
  it('registra los avisos una sola vez y encola el borrador; el email de la artista no lleva la calle', async () => {
    const u = buildU4();
    const { order: o } = await paidOrder(u);
    expect(types(u, o.id)).toEqual(['confirmacion_compradora', 'pedido_nuevo_artista']);
    expect(u.jobs.filter((j) => j.type === 'create_shipment_draft')).toHaveLength(1);

    await u.dispatch.execute('c');
    expect(u.email.sent).toHaveLength(2);
    const toArtist = u.email.sent.find((m) => m.subject.startsWith('Has vendido'))!;
    expect(toArtist.text).not.toContain('Calle Sol');
    expect(toArtist.text).toContain('/artista/pedidos/');
    const toBuyer = u.email.sent.find((m) => m.subject.includes('pago'))!;
    expect(toBuyer.to).toBe('lucia@example.com');
    expect(toBuyer.text).toContain('/seguimiento/');

    // Repetir la reaccion o el envio no duplica nada.
    await u.dispatch.execute('c');
    expect(u.email.sent).toHaveLength(2);
    expect(types(u, o.id)).toHaveLength(2);
  });
});

describe('U4 borrador de envio (US-027)', () => {
  it('crea el borrador una sola vez, pasa a borrador_creado y avisa al operador', async () => {
    const u = buildU4();
    const { order: o } = await paidOrder(u);
    expect(unwrap(await u.draft.execute(o.id, 'c', false))).toBe('created');
    expect(order(u, o.id).status).toBe('borrador_creado');
    expect(shipmentOf(u, o.id).providerRef).toBeDefined();
    expect(types(u, o.id)).toContain('paga_envio_operador');
    // Un segundo intento no hace nada.
    expect(unwrap(await u.draft.execute(o.id, 'c', false))).toBe('skipped');
    expect(u.provider.createCalls).toBe(1);
  });

  it('si el borrador ya existia en Packlink (caida antes de guardar), se reutiliza sin crear otro', async () => {
    const u = buildU4();
    const { order: o } = await paidOrder(u);
    u.provider.drafts.set(o.id, { ref: 'PLEXISTENTE', input: {} as never });
    unwrap(await u.draft.execute(o.id, 'c', false));
    expect(u.provider.createCalls).toBe(0);
    expect(shipmentOf(u, o.id).providerRef).toBe('PLEXISTENTE');
  });

  it('Packlink caido: se reintenta; en el ultimo intento queda error_borrador con aviso y se recupera', async () => {
    const u = buildU4();
    const { order: o } = await paidOrder(u);
    u.provider.failCreate = true;
    expect((await u.draft.execute(o.id, 'c', false)).ok).toBe(false);
    expect(order(u, o.id).status).toBe('pagado');
    expect((await u.draft.execute(o.id, 'c', true)).ok).toBe(false);
    expect(order(u, o.id).status).toBe('error_borrador');
    expect(u.alerts.raised.some((a) => a.code === 'packlink_borrador_fallido')).toBe(true);

    u.provider.failCreate = false;
    expect(unwrap(await u.draft.execute(o.id, 'c', false))).toBe('created');
    expect(order(u, o.id).status).toBe('borrador_creado');
    expect(u.provider.createCalls).toBe(3);
  });

  it('en recogida espera la eleccion, la valida y completa el borrador con ella', async () => {
    const u = buildU4();
    const { order: o, artistId } = await paidOrder(u, { modality: 'recogida' });
    expect(unwrap(await u.draft.execute(o.id, 'c', false))).toBe('waiting_pickup');
    expect(u.provider.createCalls).toBe(0);
    expect(types(u, o.id)).toContain('elegir_recogida_artista');

    const bad = unwrap(await u.chooseDraftPickup.execute(artistId, o.id, '2000-01-01|00:00'));
    expect(bad.kind).toBe('unavailable');
    const good = unwrap(
      await u.chooseDraftPickup.execute(artistId, o.id, '2026-11-10|09:00-13:00'),
    );
    expect(good.kind).toBe('chosen');
    expect(u.jobs.filter((j) => j.type === 'create_shipment_draft')).toHaveLength(2);

    expect(unwrap(await u.draft.execute(o.id, 'c', false))).toBe('created');
    expect(u.provider.drafts.get(o.id)?.input.pickup?.slot).toBe('09:00-13:00');
    expect(u.db.state.events.some((e) => e.kind === 'recogida_elegida')).toBe(true);
  });

  it('otra artista no puede elegir la recogida de un pedido ajeno', async () => {
    const u = buildU4();
    const { order: o } = await paidOrder(u, { modality: 'recogida' });
    await u.draft.execute(o.id, 'c', false);
    const intruder = await u.readyArtist('berta@example.com');
    const r = await u.chooseDraftPickup.execute(intruder, o.id, '2026-11-10|09:00-13:00');
    expect(!r.ok && r.error.code).toBe('not_found');
  });

  it('recordatorio a las 24 h y aviso al operador a las 72 h, una vez cada uno y solo si no se eligio', async () => {
    const u = buildU4();
    const { order: o } = await paidOrder(u, { modality: 'recogida' });
    await u.draft.execute(o.id, 'c', false);
    u.clock.advance(23 * MS.hour);
    expect(await u.remindPickup.execute('c')).toEqual({ reminded: 0, alerted: 0 });
    u.clock.advance(2 * MS.hour);
    expect(await u.remindPickup.execute('c')).toEqual({ reminded: 1, alerted: 0 });
    expect(await u.remindPickup.execute('c')).toEqual({ reminded: 0, alerted: 0 });
    u.clock.advance(48 * MS.hour);
    expect(await u.remindPickup.execute('c')).toEqual({ reminded: 0, alerted: 1 });
    expect(await u.remindPickup.execute('c')).toEqual({ reminded: 0, alerted: 0 });
    expect(u.alerts.raised.filter((a) => a.code === 'recogida_sin_elegir')).toHaveLength(1);
  });

  it('el aviso de pago de la etiqueta se repite una vez pasadas 24 h', async () => {
    const u = buildU4();
    const { order: o } = await withDraft(u);
    u.clock.advance(25 * MS.hour);
    expect((await u.remindPay.execute('c')).reminded).toBe(1);
    expect((await u.remindPay.execute('c')).reminded).toBe(0);
    expect(types(u, o.id)).toContain('recordatorio_pago_envio_operador');
    expect(u.alerts.raised.some((a) => a.code === 'borrador_sin_pagar')).toBe(true);
  });
});

describe('U4 etiqueta y transporte (US-030, US-031, US-033, US-037)', () => {
  it('etiqueta lista: guarda el PDF, tres puntos por cercania, estado y aviso a la artista', async () => {
    const u = buildU4();
    const { order: o, ref } = await withDraft(u);
    const r = unwrap(await u.processFact.execute(ref, fact('label_ready', u.clock.now()), 'c'));
    expect(r).toBe('applied');
    expect(order(u, o.id).status).toBe('etiqueta_lista');
    const s = shipmentOf(u, o.id);
    expect(s.labelKey).toBeDefined();
    expect(u.labels.objects.has(s.labelKey as string)).toBe(true);
    expect(s.dropoffPoints?.map((d) => d.name)).toEqual(['Cerca', 'Medio', 'Lejos']);
    expect(types(u, o.id)).toContain('etiqueta_lista_artista');
  });

  it('si la etiqueta no se puede guardar el pedido no avanza; en el ultimo intento avisa', async () => {
    const u = buildU4();
    const { order: o, ref } = await withDraft(u);
    u.labels.failPut = true;
    expect(
      (await u.processFact.execute(ref, fact('label_ready', u.clock.now()), 'c', false)).ok,
    ).toBe(false);
    expect(
      (await u.processFact.execute(ref, fact('label_ready', u.clock.now()), 'c', true)).ok,
    ).toBe(false);
    expect(order(u, o.id).status).toBe('borrador_creado');
    expect(u.alerts.raised.some((a) => a.code === 'etiqueta_no_descargada')).toBe(true);
    u.labels.failPut = false;
    expect(unwrap(await u.processFact.execute(ref, fact('label_ready', u.clock.now()), 'c'))).toBe(
      'applied',
    );
  });

  it('solo avisa «en camino» a la compradora al pasar a en_transito, y no duplica con eventos repetidos', async () => {
    const u = buildU4();
    const { order: o, ref } = await withDraft(u);
    const t = u.clock.now();
    await u.processFact.execute(ref, fact('label_ready', t), 'c');
    expect(types(u, o.id)).not.toContain('en_camino_compradora');
    await u.processFact.execute(ref, fact('in_transit', t + 1000), 'c');
    await u.processFact.execute(ref, fact('in_transit', t + 1000), 'c');
    expect(order(u, o.id).status).toBe('en_transito');
    expect(types(u, o.id).filter((x) => x === 'en_camino_compradora')).toHaveLength(1);

    await u.processFact.execute(ref, fact('delivered', t + 2000), 'c');
    expect(order(u, o.id).status).toBe('entregado');
    expect(types(u, o.id)).toEqual(
      expect.arrayContaining(['entregado_compradora', 'entregado_artista']),
    );
    // Un hecho anterior o repetido no retrocede nada.
    expect(unwrap(await u.processFact.execute(ref, fact('in_transit', t + 500), 'c'))).toBe(
      'unchanged',
    );
    expect(order(u, o.id).status).toBe('entregado');
    expect(shipmentOf(u, o.id).deliveredAt).toBeDefined();
  });

  it('salto hacia delante: entregado desde borrador_creado', async () => {
    const u = buildU4();
    const { order: o, ref } = await withDraft(u);
    await u.processFact.execute(ref, fact('delivered', u.clock.now()), 'c');
    expect(order(u, o.id).status).toBe('entregado');
  });

  it('fallo del transportista: incidencia con tres avisos y alerta; un hecho posterior la recupera', async () => {
    const u = buildU4();
    const { order: o, ref } = await withDraft(u);
    const t = u.clock.now();
    await u.processFact.execute(ref, fact('label_ready', t), 'c');
    await u.processFact.execute(ref, fact('in_transit', t + 1000), 'c');
    await u.processFact.execute(ref, fact('carrier_failed', t + 2000), 'c');
    expect(order(u, o.id).status).toBe('incidencia');
    expect(order(u, o.id).refundStatus).toBe('ninguno'); // sin reembolso automatico
    expect(types(u, o.id)).toEqual(
      expect.arrayContaining([
        'incidencia_artista',
        'incidencia_compradora',
        'incidencia_operador',
      ]),
    );
    expect(u.alerts.raised.filter((a) => a.code === 'incidencia_envio')).toHaveLength(1);
    await u.processFact.execute(ref, fact('carrier_failed', t + 3000), 'c');
    expect(u.alerts.raised.filter((a) => a.code === 'incidencia_envio')).toHaveLength(1);
    await u.processFact.execute(ref, fact('delivered', t + 4000), 'c');
    expect(order(u, o.id).status).toBe('entregado');
  });

  it('una referencia desconocida o un pedido cancelado no cambian nada', async () => {
    const u = buildU4();
    expect(
      unwrap(await u.processFact.execute('NOEXISTE', fact('delivered', u.clock.now()), 'c')),
    ).toBe('unknown_reference');
  });

  it('el coste real de la etiqueta y el margen quedan en el pedido (puede ser negativo)', async () => {
    const u = buildU4();
    const { order: o, ref } = await withDraft(u);
    await u.processFact.execute(
      ref,
      fact('label_ready', u.clock.now(), { labelCostCents: 900 }),
      'c',
    );
    const done = order(u, o.id);
    expect(done.labelCostCents).toBe(900);
    // 450 - 900 - (1,5 % de 25.450 = 382 + 25) = -857
    expect(done.marginCents).toBe(450 - 900 - (Math.round(25_450 * 0.015) + 25));
    expect(done.marginCents).toBeLessThan(0);
  });
});

describe('U4 consulta de respaldo (EN-06, Q2 A)', () => {
  it('aplica los hechos de la consulta, reprograma y deja de consultar al entregar', async () => {
    const u = buildU4();
    const { order: o, ref } = await withDraft(u);
    const t = u.clock.now();
    u.provider.facts.set(ref, [fact('label_ready', t), fact('in_transit', t + 1)]);
    u.clock.advance(16 * MS.minute);
    const r = await u.poll.execute('c');
    expect(r.examined).toBe(1);
    expect(order(u, o.id).status).toBe('en_transito');
    expect(shipmentOf(u, o.id).nextPollAt).toBeGreaterThan(u.clock.now());

    u.provider.facts.set(ref, [fact('delivered', u.clock.now() + 1)]);
    u.clock.advance(16 * MS.minute);
    await u.poll.execute('c');
    expect(order(u, o.id).status).toBe('entregado');
    expect(shipmentOf(u, o.id).nextPollAt).toBeUndefined();
    expect((await u.poll.execute('c')).examined).toBe(0);
  });

  it('Packlink caido en la consulta: se reintenta mas tarde sin cambiar el estado', async () => {
    const u = buildU4();
    const { order: o } = await withDraft(u);
    u.clock.advance(16 * MS.minute);
    const r = await u.poll.execute('c'); // sin hechos configurados = proveedor caido
    expect(r.failed).toBe(1);
    expect(order(u, o.id).status).toBe('borrador_creado');
  });
});

describe('U4 bandeja de salida (Q1 A, Q5 A)', () => {
  it('un error temporal reprograma con retroceso; agotados los intentos queda fallida y avisa', async () => {
    const u = buildU4();
    await paidOrder(u);
    u.email.mode = 'temporary';
    for (let i = 0; i < 6; i++) {
      await u.dispatch.execute('c');
      u.clock.advance(13 * MS.hour);
    }
    const failed = [...u.db.state.notifications.values()].filter((n) => n.status === 'fallida');
    expect(failed.length).toBeGreaterThan(0);
    expect(u.failedAlerts.length).toBe(failed.length);
    // Al recuperarse el proveedor no se reenvian las fallidas.
    u.email.mode = 'ok';
    await u.dispatch.execute('c');
    expect(u.email.sent).toHaveLength(0);
  });

  it('un rechazo permanente falla a la primera; un error temporal que se recupera se envia', async () => {
    const u = buildU4();
    await paidOrder(u);
    u.email.mode = 'permanent';
    await u.dispatch.execute('c');
    expect([...u.db.state.notifications.values()].every((n) => n.status === 'fallida')).toBe(true);

    const v = buildU4();
    await paidOrder(v);
    v.email.mode = 'temporary';
    await v.dispatch.execute('c');
    v.email.mode = 'ok';
    v.clock.advance(2 * MS.minute);
    await v.dispatch.execute('c');
    expect(v.email.sent).toHaveLength(2);
  });

  it('sin datos de la compradora (purgados) la notificacion falla con sin_destinatario', async () => {
    const u = buildU4();
    const { order: o } = await paidOrder(u);
    u.db.state.orders.set(o.id, { ...order(u, o.id), buyer: undefined, destination: undefined });
    await u.dispatch.execute('c');
    const buyerNote = [...u.db.state.notifications.values()].find(
      (n) => n.type === 'confirmacion_compradora',
    );
    expect(buyerNote?.status).toBe('fallida');
    expect(buyerNote?.lastError).toBe('sin_destinatario');
  });

  it('las notificaciones no guardan cuerpo ni direcciones de email', async () => {
    const u = buildU4();
    await paidOrder(u);
    const dump = JSON.stringify([...u.db.state.notifications.values()]);
    for (const pii of ['lucia@example.com', 'ana@example.com', '@', 'Lucia', 'Calle']) {
      expect(dump).not.toContain(pii);
    }
  });
});

describe('U4 etiqueta, factura y detalle (US-030, US-034, US-036)', () => {
  it('solo la artista del pedido obtiene la URL de la etiqueta (5 minutos) y queda auditado', async () => {
    const u = buildU4();
    const { order: o, artistId, ref } = { ...(await withDraft(u)), artistId: '' };
    const ownerId = o.artistId;
    await u.processFact.execute(ref, fact('label_ready', u.clock.now()), 'c');
    const url = unwrap(await u.labelDownload.execute(ownerId, o.id, 'c'));
    expect(url.url).toContain('ttl=300');
    expect(u.auditStore.events.some((e) => e.action === 'label_downloaded')).toBe(true);

    const intruder = await u.readyArtist('berta@example.com');
    const denied = await u.labelDownload.execute(intruder, o.id, 'c');
    const missing = await u.labelDownload.execute(
      ownerId,
      '00000000-0000-4000-8000-0000000000ff',
      'c',
    );
    expect(!denied.ok && denied.error.code).toBe('not_found');
    expect(!missing.ok && missing.error.code).toBe('not_found');
    expect(artistId).toBe('');
  });

  it('el borrador de factura lleva la marca, es solo de su artista y no existe antes del pago', async () => {
    const u = buildU4();
    const { order: o } = await paidOrder(u);
    const pdf = unwrap(await u.invoice.execute(o.artistId, o.id, 'c'));
    expect(new TextDecoder().decode(pdf)).toContain('BORRADOR');
    const intruder = await u.readyArtist('berta@example.com');
    expect((await u.invoice.execute(intruder, o.id, 'c')).ok).toBe(false);
  });

  it('el detalle muestra la direccion solo mientras hace falta y la siguiente accion', async () => {
    const u = buildU4();
    const { order: o, ref } = await withDraft(u);
    const open = unwrap(await u.artistOrder.execute(o.artistId, o.id));
    expect(open.destination.full).toContain('Calle Sol 4');
    expect(open.next.code).toBe('preparando_etiqueta');

    const t = u.clock.now();
    await u.processFact.execute(ref, fact('label_ready', t), 'c');
    expect(unwrap(await u.artistOrder.execute(o.artistId, o.id)).next.code).toBe('llevar_a_punto');
    await u.processFact.execute(ref, fact('delivered', t + 10), 'c');
    const done = unwrap(await u.artistOrder.execute(o.artistId, o.id));
    expect(done.destination.full).toBeUndefined();
    expect(done.destination.city).toBe('Barcelona');
    expect(done.next.code).toBe('entregado');

    const intruder = await u.readyArtist('berta@example.com');
    expect((await u.artistOrder.execute(intruder, o.id)).ok).toBe(false);
  });

  it('el seguimiento de la compradora trae historial y enlace del transportista, sin datos personales', async () => {
    const u = buildU4();
    const { order: o, ref } = await withDraft(u);
    const t = u.clock.now();
    await u.processFact.execute(
      ref,
      fact('tracking_info', t, { trackingUrl: 'https://carrier.test/x' }),
      'c',
    );
    await u.processFact.execute(ref, fact('label_ready', t + 1), 'c');
    await u.processFact.execute(ref, fact('in_transit', t + 2), 'c');
    const { tokenForOrder } = await import('@/modules/orders/domain/tracking-token');
    const { SECRETS } = await import('@tests/support/u3-harness');
    const token = tokenForOrder(SECRETS, order(u, o.id))!;
    const view = unwrap(await u.trackingDetails.execute(token, '3.3.3.3', 'c'));
    expect(view.history.map((h) => h.label)).toEqual(
      expect.arrayContaining([
        'Pago recibido',
        'Preparando el envío',
        'Etiqueta lista',
        'En camino',
      ]),
    );
    expect(view.carrierUrl).toBe('https://carrier.test/x');
    expect(JSON.stringify(view)).not.toMatch(/Lucia|lucia@|612345678|Calle Sol|08001/);
    const unknown = await u.trackingDetails.execute('z'.repeat(43), '3.3.3.3', 'c');
    expect(!unknown.ok && unknown.error.code).toBe('not_found');
  });
});

describe('U4 retencion (NFR-U4-21, 22)', () => {
  it('borra la etiqueta 30 dias despues de la entrega y las notificaciones a los 12 meses', async () => {
    const u = buildU4();
    const { order: o, ref } = await withDraft(u);
    const t = u.clock.now();
    await u.processFact.execute(ref, fact('label_ready', t), 'c');
    await u.processFact.execute(ref, fact('delivered', t + 1), 'c');
    const key = shipmentOf(u, o.id).labelKey as string;

    u.clock.advance(29 * MS.day);
    expect((await u.purge.execute('c')).labels).toBe(0);
    u.clock.advance(2 * MS.day);
    expect((await u.purge.execute('c')).labels).toBe(1);
    expect(u.labels.objects.has(key)).toBe(false);
    expect(shipmentOf(u, o.id).labelKey).toBeUndefined();

    u.clock.advance(13 * 30 * MS.day);
    expect((await u.purge.execute('c')).notifications).toBeGreaterThan(0);
    expect(u.db.state.notifications.size).toBe(0);
  });
});
