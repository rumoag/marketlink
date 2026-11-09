import { describe, expect, it } from 'vitest';
import { MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import type { Order } from '@/modules/orders/domain/order';
import { AUDIT_ROWS_LIMIT } from '@/modules/operator/domain/health';
import { OP_EMAIL, buildU7, deliver, paidU5Order, type U7 } from '@tests/support/u7-harness';

const order = (u: U7, id: string): Order => u.db.state.orders.get(id) as Order;
const THIRTEEN_MONTHS = 400 * MS.day;

/** Pedido entregado y liquidado (la limpieza de retención ya no espera nada). */
const settled = async (u: U7) => {
  const p = await paidU5Order(u);
  await deliver(u, p.order.id);
  await u.settle.execute(p.order.id, 'c');
  return p;
};

const noPersonalData = (u: U7): void => {
  const dump = JSON.stringify([
    u.db.state.events,
    u.auditStore.events,
    u.logger.entries,
    [...u.db.state.notifications.values()],
    u.jobs,
  ]);
  expect(dump).not.toMatch(/lucia@example|Calle Sol|612345678|Lucía/);
};

describe('U7 limpieza de datos personales (US-052)', () => {
  it('no limpia antes de los 12 meses y sí después, conservando importes y estado', async () => {
    const u = buildU7();
    const { order: o } = await settled(u);
    u.clock.advance(364 * MS.day);
    expect(await u.privacy.runBatch('c')).toEqual({ purged: 0, waiting: 0, failed: 0 });
    expect(order(u, o.id).buyer).toBeDefined();
    u.clock.advance(5 * MS.day);
    expect(await u.privacy.runBatch('c')).toEqual({ purged: 1, waiting: 0, failed: 0 });
    const after = order(u, o.id);
    expect(after.buyer).toBeUndefined();
    expect(after.destination).toBeUndefined();
    expect(after.personalPurgedAt).toBeDefined();
    expect(after).toMatchObject({
      status: 'liquidado',
      totalCents: o.totalCents,
      workPriceCents: o.workPriceCents,
      shippingCents: o.shippingCents,
    });
    expect(u.db.state.events.filter((e) => e.kind === 'datos_purgados')).toHaveLength(1);
    expect(u.auditStore.events.some((e) => e.action === 'personal_data_purged')).toBe(true);
    noPersonalData(u);
  });

  it('es idempotente: repetirla no cambia nada ni duplica eventos', async () => {
    const u = buildU7();
    await settled(u);
    u.clock.advance(THIRTEEN_MONTHS);
    await u.privacy.runBatch('c');
    const events = u.db.state.events.length;
    expect(await u.privacy.runBatch('c')).toEqual({ purged: 0, waiting: 0, failed: 0 });
    expect(u.db.state.events).toHaveLength(events);
  });

  it('la fecha de referencia es la entrega: un pedido entregado tarde espera más', async () => {
    const u = buildU7();
    const { order: o } = await paidU5Order(u);
    u.clock.advance(300 * MS.day);
    await deliver(u, o.id);
    await u.settle.execute(o.id, 'c');
    u.clock.advance(100 * MS.day); // 400 días desde el pago, pero solo 100 desde la entrega
    expect((await u.privacy.runBatch('c')).purged).toBe(0);
    u.clock.advance(270 * MS.day);
    expect((await u.privacy.runBatch('c')).purged).toBe(1);
  });

  it('espera con un reembolso en curso, una incidencia abierta o una liquidación pendiente', async () => {
    const u = buildU7();
    const { order: o } = await paidU5Order(u);
    await deliver(u, o.id); // entregado, liquidación pendiente
    u.clock.advance(THIRTEEN_MONTHS);
    expect(await u.privacy.runBatch('c')).toMatchObject({ purged: 0, waiting: 1 });

    await u.settle.execute(o.id, 'c');
    unwrap(await u.openFlag.execute(u.actor, o.id, 'Reclamación', 'c'));
    expect(await u.privacy.runBatch('c')).toMatchObject({ purged: 0, waiting: 1 });
    unwrap(await u.closeFlag.execute(u.actor, o.id, 'Resuelto', 'c'));

    u.db.state.refunds.set('r1', {
      id: 'r1',
      orderId: o.id,
      seq: 1,
      amountCents: 100,
      shippingPartCents: 100,
      artistPartCents: 0,
      status: 'solicitado',
      refundRef: undefined,
      reasonCode: 'otro',
      requestedBy: 'operador',
      createdAt: u.clock.now(),
      completedAt: undefined,
    });
    expect(await u.privacy.runBatch('c')).toMatchObject({ purged: 0, waiting: 1 });
    u.db.state.refunds.delete('r1');
    expect(await u.privacy.runBatch('c')).toMatchObject({ purged: 1, waiting: 0 });
  });
});

describe('U7 borrado a petición (BR7-PD4, PD5)', () => {
  const erase = (u: U7, orderId: string, code: string, reason = 'Petición de la compradora') =>
    u.erase.execute({ actor: u.actor, orderId, reason, code, correlationId: 'c' });

  it('exige motivo y código TOTP válido y no usado', async () => {
    const u = buildU7();
    const { order: o } = await settled(u);
    expect(await erase(u, o.id, u.nextCode(), ' ')).toEqual({
      ok: false,
      error: 'reason_required',
    });
    expect(await erase(u, o.id, '000000')).toEqual({ ok: false, error: 'code_invalid' });
    expect(order(u, o.id).buyer).toBeDefined();
    const code = u.nextCode();
    expect(await erase(u, o.id, code)).toEqual({ ok: true, status: 'purged' });
    expect(await erase(u, o.id, code)).toEqual({ ok: false, error: 'code_invalid' });
    expect(order(u, o.id).buyer).toBeUndefined();
    expect(u.auditStore.events.some((e) => e.action === 'personal_data_erased')).toBe(true);
    noPersonalData(u);
  });

  it('una segunda petición con otro código informa de que ya estaba eliminado', async () => {
    const u = buildU7();
    const { order: o } = await settled(u);
    await erase(u, o.id, u.nextCode());
    expect(await erase(u, o.id, u.nextCode())).toEqual({ ok: true, status: 'already' });
    expect(u.db.state.events.filter((e) => e.kind === 'datos_purgados')).toHaveLength(1);
  });

  it('se rechaza en la cadena activa de envío y se permite tras la entrega', async () => {
    const u = buildU7();
    const { order: o } = await paidU5Order(u);
    expect(await erase(u, o.id, u.nextCode())).toEqual({
      ok: false,
      error: 'blocked',
      block: 'cadena_de_envio_activa',
    });
    expect(order(u, o.id).buyer).toBeDefined();
    await deliver(u, o.id);
    await u.settle.execute(o.id, 'c');
    expect(await erase(u, o.id, u.nextCode())).toEqual({ ok: true, status: 'purged' });
  });

  it('un pedido inexistente y un actor no autorizado se rechazan', async () => {
    const u = buildU7();
    expect(await erase(u, '00000000-0000-4000-8000-0000000000ff', u.nextCode())).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(
      await u.erase.execute({
        actor: { email: 'otro@example.com' },
        orderId: 'x',
        reason: 'motivo',
        code: '123456',
        correlationId: 'c',
      }),
    ).toEqual({ ok: false, error: 'forbidden' });
  });
});

describe('U7 alertas de seguridad (EN-07)', () => {
  it('avisa al alcanzar el umbral, una sola vez por franja, y de nuevo en la franja siguiente', async () => {
    const u = buildU7();
    u.securityEvent('auth_failure', 9);
    expect((await u.security.execute('c')).alerted).toEqual([]);
    u.securityEvent('auth_failure', 1);
    expect((await u.security.execute('c')).alerted).toEqual(['seguridad_autenticacion']);
    expect((await u.security.execute('c')).alerted).toEqual([]); // misma franja
    expect(u.alerts.raised.filter((a) => a.code === 'seguridad_autenticacion')).toHaveLength(1);
    expect(u.jobs.some((j) => j.payload.kind === 'seguridad')).toBe(true);
    expect(u.auditStore.events.some((e) => e.action === 'security_alert')).toBe(true);
    u.clock.advance(MS.hour + MS.minute);
    u.securityEvent('auth_failure', 12);
    expect((await u.security.execute('c')).alerted).toEqual(['seguridad_autenticacion']);
  });

  it('cada tipo tiene su umbral y los bloqueos del operador no se duplican', async () => {
    const u = buildU7();
    u.securityEvent('authz_denied', 10);
    u.securityEvent('webhook_signature_invalid', 5);
    u.securityEvent('operator_locked', 1);
    const out = (await u.security.execute('c')).alerted.sort();
    expect(out).toEqual(['seguridad_autorizacion', 'seguridad_webhook']);
  });

  it('los eventos de hace más de una hora no cuentan', async () => {
    const u = buildU7();
    u.securityEvent('auth_failure', 20, u.clock.now() - 2 * MS.hour);
    expect((await u.security.execute('c')).alerted).toEqual([]);
  });

  it('avisa del volumen de la auditoría una vez al día', async () => {
    const u = buildU7();
    u.db.state.auditRowsEstimate = AUDIT_ROWS_LIMIT;
    expect((await u.security.execute('c')).alerted).toEqual(['auditoria_voluminosa']);
    expect((await u.security.execute('c')).alerted).toEqual([]);
  });

  it('el aviso no lleva datos personales', async () => {
    const u = buildU7();
    u.securityEvent('auth_failure', 10);
    await u.security.execute('c');
    expect(JSON.stringify([u.alerts.raised, u.jobs])).not.toMatch(/@|Calle/);
  });
});

describe('U7 pantalla de salud (EN-09)', () => {
  it('todo en orden: verde, con todas las secciones', async () => {
    const u = buildU7();
    const v = unwrap(await u.health.execute(u.actor));
    expect(v.state).toBe('verde');
    expect(v.reasons).toEqual([]);
    for (const s of [v.db, v.jobs, v.emails, v.work, v.alerts, v.audit, v.circuits, v.backup]) {
      expect(s.ok).toBe(true);
    }
  });

  it('la base caída pone rojo y solo esa sección falla', async () => {
    const u = buildU7();
    u.db.state.dbDown = true;
    const v = unwrap(await u.health.execute(u.actor));
    expect(v.db.ok).toBe(false);
    expect(v.jobs.ok).toBe(true);
    expect(v.state).toBe('rojo');
    expect(v.reasons[0]).toContain('base de datos');
  });

  it('trabajos fallidos, correos fallidos, circuito abierto y cuotas sin revisar dan ámbar', async () => {
    const u = buildU7();
    u.db.state.jobStats = { failed24h: 2, pending: 1, running: 0 };
    u.setCircuits([{ provider: 'packlink', state: 'open' }]);
    u.setQuotasReviewedAt(u.clock.now() - 40 * MS.day);
    const v = unwrap(await u.health.execute(u.actor));
    expect(v.state).toBe('ambar');
    expect(v.reasons.join(' ')).toMatch(/trabajos fallidos/);
    expect(v.reasons.join(' ')).toMatch(/circuito abierto/);
    expect(v.reasons.join(' ')).toMatch(/Cuotas/);
  });

  it('la copia: sin dato no cuenta fuera de live, y en live avisa; vieja pone ámbar y muy vieja rojo', async () => {
    const u = buildU7();
    expect(unwrap(await u.health.execute(u.actor)).state).toBe('verde');
    expect(unwrap(await u.healthLive.execute(u.actor)).state).toBe('ambar');
    u.db.state.backups.push({ at: u.clock.now() - 40 * MS.hour, sizeBytes: 10 });
    expect(unwrap(await u.healthLive.execute(u.actor)).state).toBe('ambar');
    u.db.state.backups.push({ at: u.clock.now() - 80 * MS.hour, sizeBytes: 10 });
    u.db.state.backups.splice(0, 1);
    expect(unwrap(await u.healthLive.execute(u.actor)).state).toBe('rojo');
  });

  it('solo el operador autorizado la ve y no expone datos personales', async () => {
    const u = buildU7();
    expect((await u.health.execute({ email: 'otro@example.com' })).ok).toBe(false);
    await paidU5Order(u);
    const v = unwrap(await u.health.execute(u.actor));
    expect(JSON.stringify(v)).not.toMatch(/lucia@example|Calle Sol|op@example/);
    expect(OP_EMAIL).toBe('op@example.com');
  });
});
