import { describe, expect, it } from 'vitest';
import { MS } from '@/modules/kernel/domain/clock';
import { conservationGap } from '@/modules/ledger/domain/ledger';
import type { Order } from '@/modules/orders/domain/order';
import { buildU5, deliver, paidU5Order, type U5 } from '@tests/support/u5-harness';

const order = (u: U5, id: string): Order => u.db.state.orders.get(id) as Order;
const balance = (u: U5, artistId: string) =>
  u.db.state.balances.get(artistId) ?? { retainedCents: 0, availableCents: 0, withdrawalCount: 0 };
const settlement = (u: U5, orderId: string) =>
  [...u.db.state.settlements.values()].find((s) => s.orderId === orderId);
const login = (u: U5): number => u.clock.now() - 60_000;

/** Pedido pagado, entregado y (si la cuenta esta activa) liquidado. */
const delivered = async (u: U5) => {
  const paid = await paidU5Order(u);
  await deliver(u, paid.order.id);
  return paid;
};

describe('U5 retencion al pagar (US-045)', () => {
  it('registra cobro, retencion y envio una sola vez y el saldo retenido es el precio de la obra', async () => {
    const u = buildU5();
    const { order: o, artistId } = await paidU5Order(u);
    const entries = u.db.state.ledger.filter((e) => e.orderId === o.id);
    expect(entries.map((e) => e.kind).sort()).toEqual(['cobro', 'envio_plataforma', 'retencion']);
    expect(balance(u, artistId).retainedCents).toBe(o.workPriceCents);
    expect(conservationGap(entries)).toBe(0);
    // Repetir el hecho de pago no duplica nada.
    const session = o.checkoutSessionId as string;
    await u.processor.execute(
      {
        eventId: 'again',
        kind: 'paid',
        sessionId: session,
        orderId: o.id,
        paymentIntentId: undefined,
      },
      'c',
    );
    expect(u.db.state.ledger.filter((e) => e.orderId === o.id)).toHaveLength(3);
    expect(balance(u, artistId).retainedCents).toBe(o.workPriceCents);
  });
});

describe('U5 liquidacion (US-046)', () => {
  it('al entregar liquida una sola vez: libro, saldo disponible, pedido liquidado y aviso', async () => {
    const u = buildU5();
    const { order: o, artistId } = await delivered(u);
    expect(settlement(u, o.id)?.status).toBe('pendiente');
    expect(await u.settle.execute(o.id, 'c')).toMatchObject({
      kind: 'transferred',
      amountCents: o.workPriceCents,
    });
    expect(order(u, o.id).status).toBe('liquidado');
    expect(order(u, o.id).chargeId).toBeDefined();
    expect(balance(u, artistId)).toMatchObject({
      retainedCents: 0,
      availableCents: o.workPriceCents,
    });
    // Repetir no crea otra transferencia ni mueve saldo.
    expect(await u.settle.execute(o.id, 'c')).toEqual({ kind: 'noop' });
    expect(u.money.transfers.size).toBe(1);
    expect(balance(u, artistId).availableCents).toBe(o.workPriceCents);
    expect(
      [...u.db.state.notifications.values()].some((n) => n.type === 'liquidacion_artista'),
    ).toBe(true);
    expect(conservationGap(u.db.state.ledger.filter((e) => e.orderId === o.id))).toBe(0);
  });

  it('con fallos intermitentes del proveedor reintenta con la misma clave y acaba en una transferencia', async () => {
    const u = buildU5();
    const { order: o } = await delivered(u);
    u.money.failTransfer = 'doubtful';
    expect((await u.settle.execute(o.id, 'c')).kind).toBe('retry');
    expect(order(u, o.id).status).toBe('entregado');
    u.money.failTransfer = 'none';
    u.clock.advance(10 * MS.minute);
    const r = await u.retry.execute('c');
    expect(r.transferred).toBe(1);
    expect(order(u, o.id).status).toBe('liquidado');
    expect(u.money.transfers.size).toBe(1);
  });

  it('agotados los intentos queda fallida y avisa al operador', async () => {
    const u = buildU5();
    const { order: o } = await delivered(u);
    u.money.failTransfer = 'definitive';
    for (let i = 0; i < 6; i += 1) {
      await u.settle.execute(o.id, 'c');
      u.clock.advance(5 * MS.hour);
    }
    expect(settlement(u, o.id)?.status).toBe('fallida');
    expect(u.alerts.raised.some((a) => a.code === 'liquidacion_fallida')).toBe(true);
    expect(order(u, o.id).status).toBe('entregado');
  });

  it('cuenta no activa: espera, reintenta cada hora, avisa a los 7 dias y liquida al activarse', async () => {
    const u = buildU5();
    const { order: o, artistId } = await delivered(u);
    u.db.state.payouts.set(artistId, {
      ...u.db.state.payouts.get(artistId)!,
      state: { status: 'restringido' },
    } as never);
    expect(await u.settle.execute(o.id, 'c')).toEqual({
      kind: 'waiting',
      reason: 'cuenta_no_activa',
    });
    expect(settlement(u, o.id)?.blockReason).toBe('cuenta_no_activa');
    expect(u.money.transferCalls).toBe(0);
    u.clock.advance(8 * MS.day);
    await u.retry.execute('c');
    await u.retry.execute('c');
    expect(u.alerts.raised.filter((a) => a.code === 'liquidacion_bloqueada')).toHaveLength(1);
    u.db.state.payouts.set(artistId, {
      ...u.db.state.payouts.get(artistId)!,
      state: { status: 'activo' },
    } as never);
    u.clock.advance(2 * MS.hour);
    await u.retry.execute('c');
    expect(order(u, o.id).status).toBe('liquidado');
  });

  it('sin cargo identificable no transfiere y avisa', async () => {
    const u = buildU5();
    const { order: o } = await delivered(u);
    u.money.noCharge = true;
    expect(await u.settle.execute(o.id, 'c')).toEqual({ kind: 'waiting', reason: 'sin_cargo' });
    expect(u.money.transferCalls).toBe(0);
    u.clock.advance(8 * MS.day);
    await u.retry.execute('c');
    expect(u.alerts.raised.some((a) => a.code === 'liquidacion_sin_cargo')).toBe(true);
  });

  it('respeta el retraso configurado', async () => {
    const u = buildU5({ delayHours: 24 });
    const { order: o } = await delivered(u);
    expect(await u.settle.execute(o.id, 'c')).toEqual({ kind: 'waiting', reason: 'retraso' });
    u.clock.advance(25 * MS.hour);
    expect((await u.settle.execute(o.id, 'c')).kind).toBe('transferred');
  });

  it('una transferencia ya creada en el proveedor se reutiliza (caida antes de guardar)', async () => {
    const u = buildU5();
    const { order: o } = await delivered(u);
    u.money.transfers.set(`liquidar:${o.id}`, {
      ref: 'tr_previa',
      orderId: o.id,
      amountCents: o.workPriceCents,
    });
    await u.settle.execute(o.id, 'c');
    expect(u.money.transferCalls).toBe(0);
    expect(settlement(u, o.id)?.transferRef).toBe('tr_previa');
  });

  it('un pago manual (Bizum directo) no genera liquidacion', async () => {
    const u = buildU5();
    const { order: o } = await paidU5Order(u);
    const manual = { ...order(u, o.id), paymentMode: 'manual' as const };
    const { registerDelivery } = await import('@/modules/payouts/application/settlement');
    await registerDelivery(u.db as never, u.ids, manual, u.clock.now());
    expect(settlement(u, o.id)).toBeUndefined();
  });
});

describe('U5 retirada (US-048)', () => {
  const ready = async (u: U5) => {
    const d = await delivered(u);
    await u.settle.execute(d.order.id, 'c');
    return d;
  };

  it('retira todo el saldo, escribe el libro antes y avisa por correo', async () => {
    const u = buildU5();
    const { order: o, artistId } = await ready(u);
    const r = await u.withdraw.execute({ artistId, loginAt: login(u), correlationId: 'c' });
    expect(r).toEqual({ ok: true, status: 'enviada', amountCents: o.workPriceCents });
    expect(balance(u, artistId).availableCents).toBe(0);
    expect([...u.db.state.withdrawals.values()][0]).toMatchObject({ status: 'enviada', seq: 1 });
    await u.dispatch.execute('c');
    expect(u.email.sent.some((m) => m.subject.includes('retirada'))).toBe(true);
  });

  it('una segunda pulsacion sin saldo no hace nada', async () => {
    const u = buildU5();
    const { artistId } = await ready(u);
    await u.withdraw.execute({ artistId, loginAt: login(u), correlationId: 'c' });
    const again = await u.withdraw.execute({ artistId, loginAt: login(u), correlationId: 'c' });
    expect(again).toEqual({ ok: false, error: 'no_balance' });
    expect(u.money.payouts.size).toBe(1);
  });

  it('exige sesion reciente', async () => {
    const u = buildU5();
    const { artistId } = await ready(u);
    const old = u.clock.now() - 16 * MS.minute;
    expect(await u.withdraw.execute({ artistId, loginAt: old, correlationId: 'c' })).toEqual({
      ok: false,
      error: 'login_not_recent',
    });
    expect(await u.withdraw.execute({ artistId, loginAt: undefined, correlationId: 'c' })).toEqual({
      ok: false,
      error: 'login_not_recent',
    });
    expect(balance(u, artistId).availableCents).toBeGreaterThan(0);
  });

  it('modo automatico: rechaza la retirada', async () => {
    const u = buildU5({ mode: 'automatico' });
    const { artistId } = await ready(u);
    expect(await u.withdraw.execute({ artistId, loginAt: login(u), correlationId: 'c' })).toEqual({
      ok: false,
      error: 'automatic_mode',
    });
  });

  it('fallo definitivo: restituye el saldo con un ajuste y avisa', async () => {
    const u = buildU5();
    const { order: o, artistId } = await ready(u);
    u.money.failPayout = 'definitive';
    const r = await u.withdraw.execute({ artistId, loginAt: login(u), correlationId: 'c' });
    expect(r).toEqual({ ok: false, error: 'payout_failed' });
    expect(balance(u, artistId).availableCents).toBe(o.workPriceCents);
    expect([...u.db.state.withdrawals.values()][0]?.status).toBe('fallida');
    expect(u.alerts.raised.some((a) => a.code === 'retirada_fallida')).toBe(true);
    // Se puede volver a pedir y usa un contador nuevo.
    u.money.failPayout = 'none';
    const ok2 = await u.withdraw.execute({ artistId, loginAt: login(u), correlationId: 'c' });
    expect(ok2).toMatchObject({ ok: true, status: 'enviada' });
  });

  it('resultado dudoso: se queda solicitada y el trabajo la confirma sin duplicar el pago', async () => {
    const u = buildU5();
    const { artistId } = await ready(u);
    u.money.loseFirstPayoutResponse = true;
    const r = await u.withdraw.execute({ artistId, loginAt: login(u), correlationId: 'c' });
    expect(r).toMatchObject({ ok: true, status: 'solicitada' });
    // Mientras tanto, otra pulsacion no crea una segunda retirada.
    expect(
      await u.withdraw.execute({ artistId, loginAt: login(u), correlationId: 'c' }),
    ).toMatchObject({
      ok: false,
    });
    u.clock.advance(6 * MS.minute);
    const res = await u.resolveWithdrawals.execute('c');
    expect(res.sent).toBe(1);
    expect([...u.db.state.withdrawals.values()][0]?.status).toBe('enviada');
    expect(u.money.payouts.size).toBe(1);
  });

  it('dudoso persistente: tras los intentos restituye el saldo', async () => {
    const u = buildU5();
    const { order: o, artistId } = await ready(u);
    u.money.failPayout = 'doubtful';
    await u.withdraw.execute({ artistId, loginAt: login(u), correlationId: 'c' });
    for (let i = 0; i < 4; i += 1) {
      u.clock.advance(6 * MS.minute);
      await u.resolveWithdrawals.execute('c');
    }
    expect([...u.db.state.withdrawals.values()][0]?.status).toBe('fallida');
    expect(balance(u, artistId).availableCents).toBe(o.workPriceCents);
  });
});

describe('U5 reembolsos (US-042)', () => {
  const refund = (u: U5, orderId: string, amountCents: number) =>
    u.refundOrder.execute({
      orderId,
      amountCents,
      reason: 'peticion_compradora',
      operatorId: 'op',
      correlationId: 'c',
    });

  it('parcial: sale primero del envio y no cambia el estado', async () => {
    const u = buildU5();
    const { order: o, artistId } = await paidU5Order(u);
    const r = await refund(u, o.id, 400);
    expect(r).toMatchObject({ ok: true, total: false });
    expect(u.db.state.refunds.size).toBe(1);
    const row = [...u.db.state.refunds.values()][0]!;
    expect(row).toMatchObject({ shippingPartCents: 400, artistPartCents: 0, status: 'hecho' });
    expect(order(u, o.id).status).toBe('pagado');
    expect(balance(u, artistId).retainedCents).toBe(o.workPriceCents);
  });

  it('total: pasa a reembolsado, deja a la artista sin retencion y anula la liquidacion', async () => {
    const u = buildU5();
    const { order: o, artistId } = await delivered(u);
    const r = await refund(u, o.id, o.totalCents);
    expect(r).toMatchObject({ ok: true, total: true });
    expect(order(u, o.id).status).toBe('reembolsado');
    expect(balance(u, artistId)).toMatchObject({ retainedCents: 0, availableCents: 0 });
    expect(conservationGap(u.db.state.ledger.filter((e) => e.orderId === o.id))).toBe(0);
    await u.settle.execute(o.id, 'c');
    expect(settlement(u, o.id)?.status).toBe('anulada');
    expect(u.money.transfers.size).toBe(0);
  });

  it('rechaza mas de lo pendiente, tras liquidar y el pago manual', async () => {
    const u = buildU5();
    const { order: o } = await delivered(u);
    expect(await refund(u, o.id, o.totalCents + 1)).toEqual({
      ok: false,
      error: 'exceeds_remaining',
    });
    await u.settle.execute(o.id, 'c');
    expect(await refund(u, o.id, 100)).toEqual({ ok: false, error: 'already_settled' });
  });

  it('repartida en dos: la suma nunca supera el total', async () => {
    const u = buildU5();
    const { order: o } = await paidU5Order(u);
    expect((await refund(u, o.id, o.totalCents - 100)).ok).toBe(true);
    expect(await refund(u, o.id, 101)).toEqual({ ok: false, error: 'exceeds_remaining' });
    expect(await refund(u, o.id, 100)).toMatchObject({ ok: true, total: true });
    expect(order(u, o.id).status).toBe('reembolsado');
  });

  it('fallo del proveedor: no toca el libro, marca fallido y avisa', async () => {
    const u = buildU5();
    const { order: o } = await paidU5Order(u);
    u.money.failRefund = true;
    expect(await refund(u, o.id, 500)).toEqual({ ok: false, error: 'provider_failed' });
    expect([...u.db.state.refunds.values()][0]?.status).toBe('fallido');
    expect(u.db.state.ledger.filter((e) => e.kind === 'reembolso')).toHaveLength(0);
    expect(u.alerts.raised.some((a) => a.code === 'reembolso_fallido')).toBe(true);
    u.money.failRefund = false;
    expect(await refund(u, o.id, 500)).toMatchObject({ ok: true });
  });
});

describe('U5 liberacion manual y entrega sin confirmar (US-041)', () => {
  it('libera con motivo, liquida y deja evento; sin motivo o en otro estado se rechaza', async () => {
    const u = buildU5();
    const { order: o } = await paidU5Order(u);
    await u.draft.execute(o.id, 'c', false);
    const bad = await u.release.execute({
      orderId: o.id,
      reason: ' ',
      operatorId: 'op',
      correlationId: 'c',
    });
    expect(bad).toEqual({ ok: false, error: 'reason_required' });
    const early = await u.release.execute({
      orderId: o.id,
      reason: 'x',
      operatorId: 'op',
      correlationId: 'c',
    });
    expect(early).toEqual({ ok: false, error: 'not_releasable' });
    const ship = [...u.db.state.shipments.values()][0]!;
    await u.processFact.execute(ship.providerRef!, { type: 'label_ready', at: u.clock.now() }, 'c');
    const ok = await u.release.execute({
      orderId: o.id,
      reason: 'Entregada segun la artista',
      operatorId: 'op',
      correlationId: 'c',
    });
    expect(ok).toMatchObject({ ok: true });
    expect(order(u, o.id).status).toBe('liquidado');
    expect(u.db.state.events.some((e) => e.kind === 'liberacion_manual')).toBe(true);
  });

  it('a los 10 dias en transito avisa una sola vez', async () => {
    const u = buildU5();
    const { order: o } = await paidU5Order(u);
    await u.draft.execute(o.id, 'c', false);
    const ship = [...u.db.state.shipments.values()][0]!;
    await u.processFact.execute(ship.providerRef!, { type: 'label_ready', at: u.clock.now() }, 'c');
    await u.processFact.execute(
      ship.providerRef!,
      { type: 'in_transit', at: (u.clock.now() + 1) as never },
      'c',
    );
    u.clock.advance(9 * MS.day);
    expect((await u.stale.execute('c')).alerted).toBe(0);
    u.clock.advance(2 * MS.day);
    expect((await u.stale.execute('c')).alerted).toBe(1);
    expect((await u.stale.execute('c')).alerted).toBe(0);
    expect(u.alerts.raised.filter((a) => a.code === 'entrega_sin_confirmar')).toHaveLength(1);
  });
});

describe('U5 conciliacion, exportacion y eventos del cobro', () => {
  it('la conciliacion no corrige: avisa si el saldo no coincide con el libro', async () => {
    const u = buildU5();
    const { artistId } = await delivered(u);
    expect((await u.recompute.execute('c')).mismatches).toBe(0);
    u.db.state.balances.set(artistId, { ...balance(u, artistId), artistId, retainedCents: 1 });
    expect((await u.recompute.execute('c')).mismatches).toBe(1);
    expect(balance(u, artistId).retainedCents).toBe(1); // no se corrige solo
    expect(u.alerts.raised.some((a) => a.code === 'conciliacion_desajuste')).toBe(true);
  });

  it('detecta un pedido que no conserva el dinero', async () => {
    const u = buildU5();
    const { order: o } = await paidU5Order(u);
    expect((await u.reconcile.execute('c')).mismatches).toBe(0);
    u.db.state.ledger.push({
      at: u.clock.now(),
      orderId: o.id,
      artistId: undefined,
      kind: 'ajuste',
      bucket: 'plataforma',
      deltaCents: 5,
      ref: undefined,
      reasonCode: undefined,
      entryKey: 'x',
    });
    expect((await u.reconcile.execute('c')).mismatches).toBe(1);
  });

  it('exporta el mes en CSV sin datos personales y es idempotente', async () => {
    const u = buildU5();
    const { order: o } = await delivered(u);
    await u.settle.execute(o.id, 'c');
    const d = new Date(u.clock.now());
    const month = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
    const first = await u.exportFinance.execute('c', month);
    expect(first).toMatchObject({ key: expect.stringMatching(/^\d{4}-\d{2}\.csv$/) });
    const key = (first as { key: string }).key;
    const csv = u.exportsStorage.files.get(key)!;
    expect(csv.split('\n')[0]).toContain('tipo,fecha');
    expect(csv).toContain('liquidacion');
    expect(csv).not.toContain('lucia@example.com');
    expect(csv).not.toContain('Calle Sol');
    await u.exportFinance.execute('c', month);
    expect(u.exportsStorage.files.get(key)).toBe(csv);
    u.exportsStorage.failing = true;
    expect(await u.exportFinance.execute('c', month)).toHaveProperty('error');
  });

  it('un reembolso hecho fuera del servicio y una disputa avisan sin mover dinero', async () => {
    const u = buildU5();
    const { order: o } = await paidU5Order(u);
    const pi = 'pi_externo';
    u.db.state.orders.set(o.id, { ...order(u, o.id), paymentIntentId: pi });
    const ledgerBefore = u.db.state.ledger.length;
    const ev = (type: 'charge_refunded' | 'dispute_created', amount: number) => ({
      id: `e-${type}`,
      type,
      sessionId: '',
      orderId: undefined,
      paymentIntentId: pi,
      paid: false,
      amountCents: amount,
    });
    expect(await u.charge.execute(ev('charge_refunded', 300), 'c')).toBe('alerted');
    expect(await u.charge.execute(ev('dispute_created', 100), 'c')).toBe('alerted');
    expect(u.alerts.raised.map((a) => a.code)).toEqual(
      expect.arrayContaining(['reembolso_externo', 'disputa_abierta']),
    );
    expect(u.db.state.ledger.length).toBe(ledgerBefore);
    // Un reembolso propio ya registrado no avisa.
    await u.refundOrder.execute({
      orderId: o.id,
      amountCents: 300,
      reason: 'otro',
      operatorId: 'op',
      correlationId: 'c',
    });
    u.alerts.raised.length = 0;
    expect(await u.charge.execute(ev('charge_refunded', 300), 'c')).toBe('known');
    expect(u.alerts.raised).toHaveLength(0);
  });
});

describe('U5 pantalla de dinero (US-047)', () => {
  it('explica por que cada pedido sigue retenido y solo ve lo propio', async () => {
    const u = buildU5();
    const { order: o, artistId } = await paidU5Order(u);
    const ov = await u.overview.execute(artistId);
    expect(ov.retainedCents).toBe(o.workPriceCents);
    expect(ov.retained[0]?.reason).toBe('Esperando la etiqueta');
    expect(ov.accountActive).toBe(true);
    const other = await u.overview.execute('00000000-0000-4000-8000-0000000000ff');
    expect(other.retained).toHaveLength(0);
    expect(other.movements).toHaveLength(0);
  });
});
