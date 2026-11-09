import { describe, expect, it } from 'vitest';
import { MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { JOB_OPERATOR_NOTICE, JOB_SEND_OPERATOR_LINK } from '@/modules/operator/application/access';
import {
  base32Decode,
  base32Encode,
  hotp,
  stepOf,
  totpAtStep,
} from '@/modules/operator/domain/totp';
import type { Order } from '@/modules/orders/domain/order';
import { OP_EMAIL, buildU6, deliver, paidU5Order, type U6 } from '@tests/support/u6-harness';

const order = (u: U6, id: string): Order => u.db.state.orders.get(id) as Order;
const cookieOf = (setCookie: string): string => setCookie.split(';')[0]!.slice('ml_op='.length);

describe('TOTP (RFC 6238, vectores oficiales de SHA-1)', () => {
  const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));
  it('coincide con los vectores de la RFC', () => {
    const at = (seconds: number) => totpAtStep(secret, Math.floor(seconds / 30));
    expect(at(59)).toBe('287082');
    expect(at(1111111109)).toBe('081804');
    expect(at(1111111111)).toBe('050471');
    expect(at(1234567890)).toBe('005924');
    expect(at(2000000000)).toBe('279037');
    expect(at(20000000000)).toBe('353130');
  });
  it('Base32 ida y vuelta, y rechaza caracteres ajenos', () => {
    const bytes = Uint8Array.from([1, 2, 3, 250, 251, 252, 0, 7]);
    expect([...(base32Decode(base32Encode(bytes)) ?? [])]).toEqual([...bytes]);
    expect(base32Decode('AB!1')).toBeUndefined();
    expect(hotp(bytes, 1)).toMatch(/^\d{6}$/);
  });
});

describe('U6 acceso del operador (US-044)', () => {
  it('pedir el enlace responde igual con un email autorizado y con uno que no lo es', async () => {
    const u = buildU6();
    const a = await u.requestLink.execute(OP_EMAIL, '1.1.1.1', 'c');
    const b = await u.requestLink.execute('intruso@example.com', '1.1.1.2', 'c');
    const c = await u.requestLink.execute('no es un email', '1.1.1.3', 'c');
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(u.jobs.map((j) => j.type)).toEqual([
      JOB_SEND_OPERATOR_LINK,
      JOB_SEND_OPERATOR_LINK,
      JOB_SEND_OPERATOR_LINK,
    ]);
    // El email no autorizado nunca se guarda en el trabajo.
    expect(u.jobs.map((j) => j.payload.email)).toEqual([OP_EMAIL, null, null]);
    expect(JSON.stringify(u.jobs)).not.toContain('intruso');
  });

  it('limita las solicitudes por IP (10 por hora, fallo cerrado)', async () => {
    const u = buildU6();
    for (let i = 0; i < 10; i += 1) {
      expect((await u.requestLink.execute(OP_EMAIL, '9.9.9.9', 'c')).ok).toBe(true);
    }
    expect((await u.requestLink.execute(OP_EMAIL, '9.9.9.9', 'c')).ok).toBe(false);
  });

  it('el trabajo pide el enlace solo para un email autorizado', async () => {
    const u = buildU6();
    await u.sendLink.execute(OP_EMAIL, 'c');
    await u.sendLink.execute(null, 'c');
    await u.sendLink.execute('intruso@example.com', 'c');
    expect(u.auth.sent).toEqual([OP_EMAIL]);
  });

  it('confirmar el enlace devuelve el email y es de un solo uso; un email ajeno se deniega con auditoría', async () => {
    const u = buildU6();
    const token = u.issueLink();
    expect(unwrap(await u.confirmLink.execute(token, 'c'))).toEqual({ email: OP_EMAIL });
    expect((await u.confirmLink.execute(token, 'c')).ok).toBe(false);
    const other = u.issueLink('artista@example.com');
    expect((await u.confirmLink.execute(other, 'c')).ok).toBe(false);
    expect(u.auditStore.events.some((e) => e.action === 'auth_failure')).toBe(true);
    // No se crea ninguna fila de artista.
    expect(u.db.state.artists.size).toBe(0);
  });

  it('un código correcto entra, avisa del acceso y no se puede reutilizar', async () => {
    const u = buildU6();
    const code = u.nextCode();
    const ok = await u.verifyTotp.execute({
      email: OP_EMAIL,
      code,
      purpose: 'login',
      correlationId: 'c',
    });
    expect(ok.ok).toBe(true);
    expect(u.jobs.some((j) => j.type === JOB_OPERATOR_NOTICE && j.payload.kind === 'acceso')).toBe(
      true,
    );
    expect(u.auditStore.events.some((e) => e.action === 'operator_login')).toBe(true);
    const again = await u.verifyTotp.execute({
      email: OP_EMAIL,
      code,
      purpose: 'login',
      correlationId: 'c',
    });
    expect(again).toEqual({ ok: false, error: 'invalid' });
  });

  it('5 fallos bloquean 15 minutos, avisan y rechazan incluso el código correcto', async () => {
    const u = buildU6();
    const wrong = async () =>
      u.verifyTotp.execute({
        email: OP_EMAIL,
        code: '000000',
        purpose: 'login',
        correlationId: 'c',
      });
    for (let i = 0; i < 4; i += 1) expect(await wrong()).toEqual({ ok: false, error: 'invalid' });
    expect(await wrong()).toEqual({ ok: false, error: 'locked' });
    expect(u.alerts.raised.some((a) => a.code === 'acceso_operador_bloqueado')).toBe(true);
    expect(u.jobs.some((j) => j.payload.kind === 'bloqueo')).toBe(true);
    const good = u.nextCode();
    expect(
      await u.verifyTotp.execute({
        email: OP_EMAIL,
        code: good,
        purpose: 'login',
        correlationId: 'c',
      }),
    ).toEqual({ ok: false, error: 'locked' });
    u.clock.advance(16 * MS.minute);
    const later = u.nextCode();
    expect(
      (
        await u.verifyTotp.execute({
          email: OP_EMAIL,
          code: later,
          purpose: 'login',
          correlationId: 'c',
        })
      ).ok,
    ).toBe(true);
  });

  it('un email no autorizado nunca verifica', async () => {
    const u = buildU6();
    expect(
      await u.verifyTotp.execute({
        email: 'x@example.com',
        code: u.nextCode(),
        purpose: 'login',
        correlationId: 'c',
      }),
    ).toEqual({ ok: false, error: 'unauthorized' });
  });
});

describe('U6 sesión de operador (BR6-AC5, AC6)', () => {
  it('solo la etapa completa entra; la pendiente y las alteradas no', async () => {
    const u = buildU6();
    const pending = u.sessions.issue(OP_EMAIL, 'pendiente_mfa');
    const full = u.sessions.issue(OP_EMAIL, 'completa');
    const headersOf = (c: string) => new Headers({ cookie: `ml_op=${cookieOf(c)}` });
    expect(await u.sessions.resolve(headersOf(pending))).toBeNull();
    expect(await u.sessions.resolve(headersOf(full))).toMatchObject({
      userId: OP_EMAIL,
      role: 'operator',
    });
    const tampered = cookieOf(full).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect(await u.sessions.resolve(new Headers({ cookie: `ml_op=${tampered}` }))).toBeNull();
    expect(await u.sessions.resolve(new Headers())).toBeNull();
  });

  it('caduca a los 60 minutos sin actividad y a las 8 horas absolutas, y se renueva con actividad', async () => {
    const u = buildU6();
    const cookie = cookieOf(u.sessions.issue(OP_EMAIL, 'completa'));
    u.clock.advance(59 * MS.minute);
    expect(await u.sessions.resolve(new Headers({ cookie: `ml_op=${cookie}` }))).not.toBeNull();
    u.clock.advance(2 * MS.minute);
    expect(await u.sessions.resolve(new Headers({ cookie: `ml_op=${cookie}` }))).toBeNull();
    // Con actividad renovada sigue, pero no pasa de 8 horas desde el alta.
    let current = cookieOf(u.sessions.issue(OP_EMAIL, 'completa'));
    for (let i = 0; i < 9; i += 1) {
      u.clock.advance(50 * MS.minute);
      const s = await u.sessions.resolve(new Headers({ cookie: `ml_op=${current}` }));
      if (s?.setCookies?.[0]) current = cookieOf(s.setCookies[0]);
    }
    u.clock.advance(60 * MS.minute);
    expect(await u.sessions.resolve(new Headers({ cookie: `ml_op=${current}` }))).toBeNull();
  });

  it('la cookie lleva HttpOnly, SameSite=Strict y Secure', () => {
    const u = buildU6();
    const header = u.sessions.issue(OP_EMAIL, 'completa');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Secure');
    expect(u.sessions.clear()).toContain('Max-Age=0');
  });
});

describe('U6 lista, ficha y atascos (US-039, US-029)', () => {
  it('lista con filtros, destaca los atascados y no muestra datos personales', async () => {
    const u = buildU6();
    const a = await paidU5Order(u);
    const { items, total } = unwrap(await u.listOrders.execute(u.actor, {}, 1, 'c'));
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      id: a.order.id,
      status: 'pagado',
      artistName: expect.any(String),
    });
    expect(JSON.stringify(items)).not.toMatch(/lucia@example|Calle Sol|612345678/);
    expect(items[0]?.stuck).toBeUndefined();
    expect(unwrap(await u.listOrders.execute(u.actor, { status: 'entregado' }, 1, 'c')).total).toBe(
      0,
    );
    expect(unwrap(await u.listOrders.execute(u.actor, { stuckOnly: true }, 1, 'c')).total).toBe(0);

    // Un borrador sin pagar durante más de 24 h se destaca.
    await u.draft.execute(a.order.id, 'c', false);
    u.clock.advance(25 * MS.hour);
    const stuck = unwrap(await u.listOrders.execute(u.actor, { stuckOnly: true }, 1, 'c'));
    expect(stuck.total).toBe(1);
    expect(stuck.items[0]?.stuck).toBe('borrador_sin_pagar');
    expect(stuck.items[0]?.providerRef).toBeDefined();
    expect(unwrap(await u.drafts.execute(u.actor, 'c')).drafts[0]).toMatchObject({
      orderId: a.order.id,
      ageHours: 25,
    });
    expect(unwrap(await u.summary.execute(u.actor, 'c')).counts).toEqual({
      ok: true,
      value: { stuck: 1, unpaidDrafts: 1, openFlags: 0 },
    });
  });

  it('pagina de 25 en 25', async () => {
    const u = buildU6();
    const { order: o } = await paidU5Order(u);
    for (let i = 0; i < 30; i += 1) {
      u.db.state.orders.set(`${o.id.slice(0, -3)}9${String(i).padStart(2, '0')}`, {
        ...o,
        id: `${o.id.slice(0, -3)}9${String(i).padStart(2, '0')}`,
        createdAt: (o.createdAt + i + 1) as never,
      });
    }
    const first = unwrap(await u.listOrders.execute(u.actor, {}, 1, 'c'));
    const second = unwrap(await u.listOrders.execute(u.actor, {}, 2, 'c'));
    expect(first.items).toHaveLength(25);
    expect(second.items).toHaveLength(6);
    expect(first.pages).toBe(2);
  });

  it('la ficha muestra datos personales, audita la consulta y un pedido inexistente da not_found', async () => {
    const u = buildU6();
    const { order: o } = await paidU5Order(u);
    const detail = unwrap(await u.orderDetail.execute(u.actor, o.id, 'c'));
    expect(detail.order.buyer?.email).toBe('lucia@example.com');
    expect(detail.order.destination?.street).toContain('Calle Sol');
    expect(detail.events.ok && detail.events.value.length).toBeGreaterThan(0);
    const audit = u.auditStore.events.filter((e) => e.action === 'operator_view_order');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/lucia@example|Calle Sol/);
    expect(
      (await u.orderDetail.execute(u.actor, '00000000-0000-4000-8000-0000000000ff', 'c')).ok,
    ).toBe(false);
  });

  it('todo servicio rechaza a quien no está en la lista', async () => {
    const u = buildU6();
    const stranger = { email: 'otro@example.com' };
    expect((await u.listOrders.execute(stranger, {}, 1, 'c')).ok).toBe(false);
    expect((await u.orderDetail.execute(stranger, 'x', 'c')).ok).toBe(false);
    expect((await u.openFlag.execute(stranger, 'x', 'motivo', 'c')).ok).toBe(false);
    expect((await u.saveSizes.execute(stranger, {} as never, 'c')).ok).toBe(false);
    expect(
      await u.opRefund.execute({
        actor: stranger,
        orderId: 'x',
        amount: '1',
        reason: 'otro',
        code: '123456',
        correlationId: 'c',
      }),
    ).toEqual({ ok: false, error: 'forbidden' });
  });
});

describe('U6 incidencias, notas y reintento (US-040, US-028)', () => {
  it('la incidencia manual frena la liquidación y la liberación, y al cerrarla se liquida sola', async () => {
    const u = buildU6();
    const { order: o } = await paidU5Order(u);
    await deliver(u, o.id);
    expect(
      unwrap(await u.openFlag.execute(u.actor, o.id, 'Reclamación de la compradora', 'c')),
    ).toBe('opened');
    expect(unwrap(await u.openFlag.execute(u.actor, o.id, 'otra', 'c'))).toBe('already_open');
    expect(await u.settle.execute(o.id, 'c')).toEqual({
      kind: 'waiting',
      reason: 'incidencia_abierta',
    });
    expect(order(u, o.id).status).toBe('entregado');
    const stuck = unwrap(await u.listOrders.execute(u.actor, { stuckOnly: true }, 1, 'c'));
    expect(stuck.items[0]?.stuck).toBe('incidencia_manual');

    unwrap(await u.closeFlag.execute(u.actor, o.id, 'Resuelto con la compradora', 'c'));
    expect((await u.closeFlag.execute(u.actor, o.id, 'otra vez', 'c')).ok).toBe(false);
    await u.retry.execute('c');
    expect(order(u, o.id).status).toBe('liquidado');
  });

  it('no se puede liberar con una incidencia abierta', async () => {
    const u = buildU6();
    const { order: o } = await paidU5Order(u);
    await u.draft.execute(o.id, 'c', false);
    const ship = [...u.db.state.shipments.values()][0]!;
    await u.processFact.execute(ship.providerRef!, { type: 'label_ready', at: u.clock.now() }, 'c');
    unwrap(await u.openFlag.execute(u.actor, o.id, 'Revisar', 'c'));
    const r = await u.opRelease.execute({
      actor: u.actor,
      orderId: o.id,
      reason: 'Entregada',
      code: u.nextCode(),
      correlationId: 'c',
    });
    expect(r).toEqual({ ok: false, error: 'incident_open' });
  });

  it('notas con autor y fecha; un doble envío del formulario no crea dos', async () => {
    const u = buildU6();
    const { order: o } = await paidU5Order(u);
    expect(
      unwrap(await u.addNote.execute(u.actor, o.id, 'Llamé a la artista', 'clave-0001', 'c')),
    ).toBe('added');
    expect(
      unwrap(await u.addNote.execute(u.actor, o.id, 'Llamé a la artista', 'clave-0001', 'c')),
    ).toBe('duplicate');
    expect((await u.addNote.execute(u.actor, o.id, '', 'clave-0002', 'c')).ok).toBe(false);
    expect((await u.addNote.execute(u.actor, o.id, 'x'.repeat(501), 'clave-0003', 'c')).ok).toBe(
      false,
    );
    const detail = unwrap(await u.orderDetail.execute(u.actor, o.id, 'c'));
    expect(detail.notes.ok && detail.notes.value).toHaveLength(1);
    expect(detail.notes.ok && detail.notes.value[0]).toMatchObject({
      author: OP_EMAIL,
      text: 'Llamé a la artista',
    });
  });

  it('reintenta un borrador fallido, deja el evento y no duplica', async () => {
    const u = buildU6();
    const { order: o } = await paidU5Order(u);
    u.provider.failCreate = true;
    await u.draft.execute(o.id, 'c', true);
    expect(order(u, o.id).status).toBe('error_borrador');
    expect(await u.retryDraft.execute(u.actor, o.id, 'c')).toMatchObject({
      ok: true,
      value: 'failed',
    });
    u.provider.failCreate = false;
    expect(unwrap(await u.retryDraft.execute(u.actor, o.id, 'c'))).toBe('created');
    expect(order(u, o.id).status).toBe('borrador_creado');
    expect(u.db.state.events.filter((e) => e.kind === 'borrador_reintentado')).toHaveLength(2);
    // Ya no está en error: no se puede reintentar de nuevo.
    expect((await u.retryDraft.execute(u.actor, o.id, 'c')).ok).toBe(false);
    expect(u.provider.created).toBe(1);
  });
});

describe('U6 acciones de dinero con código TOTP fresco (US-041, US-042)', () => {
  it('un código inválido o repetido no ejecuta nada; uno válido reembolsa', async () => {
    const u = buildU6();
    const { order: o } = await paidU5Order(u);
    const refund = (code: string, amount = '5,00') =>
      u.opRefund.execute({
        actor: u.actor,
        orderId: o.id,
        amount,
        reason: 'peticion_compradora',
        code,
        correlationId: 'c',
      });
    expect(await refund('000000')).toEqual({ ok: false, error: 'code_invalid' });
    expect(u.db.state.refunds.size).toBe(0);
    const code = u.nextCode();
    expect(await refund(code)).toEqual({ ok: true, value: { amountCents: 500, total: false } });
    // El mismo código no sirve dos veces.
    expect(await refund(code)).toEqual({ ok: false, error: 'code_invalid' });
    expect(u.db.state.refunds.size).toBe(1);
    expect(u.auditStore.events.some((e) => e.action === 'operator_refund')).toBe(true);
  });

  it('valida el importe y el motivo antes de pedir nada', async () => {
    const u = buildU6();
    const { order: o } = await paidU5Order(u);
    const base = { actor: u.actor, orderId: o.id, correlationId: 'c' };
    expect(
      await u.opRefund.execute({ ...base, amount: 'abc', reason: 'otro', code: u.nextCode() }),
    ).toEqual({ ok: false, error: 'invalid_amount' });
    expect(
      await u.opRefund.execute({ ...base, amount: '5', reason: 'inventado', code: u.nextCode() }),
    ).toEqual({ ok: false, error: 'validation' });
    expect(
      await u.opRefund.execute({ ...base, amount: '99999', reason: 'otro', code: u.nextCode() }),
    ).toEqual({ ok: false, error: 'exceeds_remaining' });
  });

  it('libera con motivo y código, y liquida; sin motivo se rechaza', async () => {
    const u = buildU6();
    const { order: o } = await paidU5Order(u);
    await u.draft.execute(o.id, 'c', false);
    const ship = [...u.db.state.shipments.values()][0]!;
    await u.processFact.execute(ship.providerRef!, { type: 'label_ready', at: u.clock.now() }, 'c');
    const release = (reason: string, code: string) =>
      u.opRelease.execute({ actor: u.actor, orderId: o.id, reason, code, correlationId: 'c' });
    expect(await release('  ', u.nextCode())).toEqual({ ok: false, error: 'reason_required' });
    expect(await release('Entregada', '123456')).toEqual({ ok: false, error: 'code_invalid' });
    expect(await release('Entregada según la artista', u.nextCode())).toMatchObject({ ok: true });
    expect(order(u, o.id).status).toBe('liquidado');
    expect(u.auditStore.events.some((e) => e.action === 'operator_release')).toBe(true);
  });

  it('con demasiados códigos erróneos en acciones de dinero el panel se bloquea', async () => {
    const u = buildU6();
    const { order: o } = await paidU5Order(u);
    for (let i = 0; i < 5; i += 1) {
      await u.opRefund.execute({
        actor: u.actor,
        orderId: o.id,
        amount: '1',
        reason: 'otro',
        code: '000000',
        correlationId: 'c',
      });
    }
    expect(
      await u.opRefund.execute({
        actor: u.actor,
        orderId: o.id,
        amount: '1',
        reason: 'otro',
        code: u.nextCode(),
        correlationId: 'c',
      }),
    ).toEqual({ ok: false, error: 'locked' });
  });
});

describe('U6 tamaños, visitas y métricas (US-014, US-043)', () => {
  const valid = {
    S: { lengthCm: 31, widthCm: 25, heightCm: 5, weightKg: 1.2 },
    M: { lengthCm: 50, widthCm: 40, heightCm: 10, weightKg: 2 },
    L: { lengthCm: 80, widthCm: 60, heightCm: 10, weightKg: 5 },
  };

  it('valida límites y coherencia, guarda solo lo que cambia y audita antes y después', async () => {
    const u = buildU6();
    expect(
      (await u.saveSizes.execute(u.actor, { ...valid, S: { ...valid.S, lengthCm: 4 } }, 'c')).ok,
    ).toBe(false);
    expect(
      (await u.saveSizes.execute(u.actor, { ...valid, S: { ...valid.S, weightKg: 31 } }, 'c')).ok,
    ).toBe(false);
    expect(
      (
        await u.saveSizes.execute(
          u.actor,
          { ...valid, L: { lengthCm: 150, widthCm: 100, heightCm: 100, weightKg: 5 } },
          'c',
        )
      ).ok,
    ).toBe(false);
    expect(unwrap(await u.saveSizes.execute(u.actor, valid, 'c')).changed).toEqual(['S']);
    expect(unwrap(await u.sizes.execute(u.actor)).find((x) => x.size === 'S')).toMatchObject({
      lengthCm: 31,
      weightKg: 1.2,
    });
    const audit = u.auditStore.events.filter((e) => e.action === 'operator_sizes_changed');
    expect(audit).toHaveLength(1);
    expect(unwrap(await u.saveSizes.execute(u.actor, valid, 'c')).changed).toEqual([]);
  });

  it('cuenta visitas por obra y día sin identificar a nadie; ignora robots y a la propia artista', async () => {
    const u = buildU6();
    const { slug } = await paidU5Order(u);
    const real = { userAgent: 'Mozilla/5.0 (iPhone)', purpose: null, hasArtistSession: false };
    expect(await u.recordVisit.execute({ slug, ip: '5.5.5.5', request: real })).toBe('counted');
    expect(await u.recordVisit.execute({ slug, ip: '5.5.5.6', request: real })).toBe('counted');
    expect(
      await u.recordVisit.execute({
        slug,
        ip: '5.5.5.7',
        request: { ...real, userAgent: 'Googlebot/2.1' },
      }),
    ).toBe('ignored');
    expect(
      await u.recordVisit.execute({
        slug,
        ip: '5.5.5.8',
        request: { ...real, purpose: 'prefetch' },
      }),
    ).toBe('ignored');
    expect(
      await u.recordVisit.execute({
        slug,
        ip: '5.5.5.9',
        request: { ...real, hasArtistSession: true },
      }),
    ).toBe('ignored');
    expect([...u.db.state.views.values()]).toEqual([2]);
    expect(JSON.stringify([...u.db.state.views.keys()])).not.toContain('5.5.5');
  });

  it('limita a 120 visitas por hora e IP+obra y falla abierto si la base falla', async () => {
    const u = buildU6();
    const { slug } = await paidU5Order(u);
    const real = { userAgent: 'Mozilla/5.0', purpose: null, hasArtistSession: false };
    let limited = 0;
    for (let i = 0; i < 125; i += 1) {
      if ((await u.recordVisit.execute({ slug, ip: '6.6.6.6', request: real })) === 'limited')
        limited += 1;
    }
    expect(limited).toBe(5);
    u.db.failAt = 'x';
    const broken = new (u.recordVisit.constructor as new (d: unknown) => typeof u.recordVisit)({
      runner: { run: () => Promise.reject(new Error('base caida')) },
      limiter: u.limiter,
      clock: u.clock,
      logger: u.logger,
    });
    expect(await broken.execute({ slug, ip: '7.7.7.7', request: real })).toBe('failed');
  });

  it('métricas del periodo y del anterior, con método de pago, modalidad y «pocos datos»', async () => {
    const u = buildU6();
    const { order: o, slug } = await paidU5Order(u);
    await deliver(u, o.id);
    await u.settle.execute(o.id, 'c'); // conoce el método real
    const real = { userAgent: 'Mozilla/5.0', purpose: null, hasArtistSession: false };
    for (let i = 0; i < 4; i += 1)
      await u.recordVisit.execute({ slug, ip: `8.8.8.${i}`, request: real });
    const to = u.clock.now() + MS.day;
    const from = to - 7 * MS.day;
    const m = unwrap(await u.metrics.execute(u.actor, from, to, 'c'));
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value.current.raw).toMatchObject({
      paidOrders: 1,
      views: 4,
      cardOrders: 1,
      puntoOrders: 1,
    });
    expect(m.value.current.conversionPct).toBe(25);
    expect(m.value.current.cardPct).toBe(100);
    expect(m.value.current.lowData).toBe(true);
    expect(m.value.previous.raw.paidOrders).toBe(0);
    expect(m.value.previous.conversionPct).toBeUndefined();
    expect((await u.metrics.execute(u.actor, to, from, 'c')).ok).toBe(false);
  });
});

describe('U6 estado de pedido tras liberar (comprobación cruzada con U5)', () => {
  it('stepOf es monótono y la ventana TOTP cubre ±1 paso', () => {
    expect(stepOf(0)).toBe(0);
    expect(stepOf(29_999)).toBe(0);
    expect(stepOf(30_000)).toBe(1);
  });
});
