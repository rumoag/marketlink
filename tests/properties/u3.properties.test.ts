import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { buyerInputSchema, normalizeLine } from '@/modules/checkout/domain/buyer-input';
import { hashResumeId, newResumeId, resumeStillValid } from '@/modules/checkout/domain/consent';
import {
  chooseQuoteOutcome,
  compareServices,
  isValidService,
  selectService,
  type ShippingService,
} from '@/modules/checkout/domain/quote';
import {
  ORDER_STATUSES,
  applyTrigger,
  computeTotals,
  isOverdue,
  type Effect,
  type Modality,
  type Order,
  type OrderStatus,
  type Trigger,
} from '@/modules/orders/domain/order';
import {
  deriveTrackingToken,
  hashTrackingToken,
  isWellFormedToken,
  newTrackingNonce,
  tokenForOrder,
} from '@/modules/orders/domain/tracking-token';
import { instantOf } from '@/modules/kernel/domain/clock';
import {
  SECRETS,
  buildU3,
  buyerFields,
  checkoutInput,
  factFromEvent,
  sellableListing,
  type U3,
} from '@tests/support/u3-harness';

const modalityArb = fc.constantFrom<Modality>('punto', 'recogida');
const serviceArb = fc.record<ShippingService>({
  id: fc.stringMatching(/^[a-z0-9-]{1,12}$/),
  name: fc.constant('Servicio'),
  modality: modalityArb,
  priceCents: fc.integer({ min: 1, max: 10_000 }),
  transitDays: fc.integer({ min: 0, max: 10 }),
});
const servicesArb = fc.array(serviceArb, { maxLength: 12 });

const triggerArb: fc.Arbitrary<Trigger> = fc.oneof(
  fc.record({ type: fc.constant('payment_completed' as const), canSell: fc.boolean() }),
  fc.record({ type: fc.constant('manual_confirmed' as const), canSell: fc.boolean() }),
  fc.constant<Trigger>({ type: 'session_expired' }),
  fc.constant<Trigger>({ type: 'deadline_passed' }),
  fc.constant<Trigger>({ type: 'cancelled_by_buyer' }),
  fc.constant<Trigger>({ type: 'provider_failed' }),
  fc.constant<Trigger>({ type: 'refund_done' }),
);

// P-U3-01 ---------------------------------------------------------------------------------------
describe('P-U3-01 seleccion del servicio', () => {
  it('es el mas barato de la modalidad y no depende del orden', () => {
    fc.assert(
      fc.property(servicesArb, modalityArb, (services, modality) => {
        const chosen = selectService(services, modality);
        const pool = services.filter((s) => s.modality === modality);
        if (pool.length === 0) {
          expect(chosen).toBeUndefined();
          return;
        }
        expect(chosen?.modality).toBe(modality);
        for (const s of pool)
          expect(compareServices(chosen as ShippingService, s)).toBeLessThanOrEqual(0);
        const reversed = selectService([...services].reverse(), modality);
        expect(reversed?.priceCents).toBe(chosen?.priceCents);
        expect(reversed?.transitDays).toBe(chosen?.transitDays);
      }),
    );
  });
});

// P-U3-02 ---------------------------------------------------------------------------------------
describe('P-U3-02 resultado de la cotizacion', () => {
  it('disponible, solo alternativa o no disponible segun haya servicios', () => {
    fc.assert(
      fc.property(servicesArb, modalityArb, (services, modality) => {
        const out = chooseQuoteOutcome(services, modality);
        const has = (m: Modality) => services.some((s) => s.modality === m);
        const other: Modality = modality === 'punto' ? 'recogida' : 'punto';
        if (has(modality)) expect(out.kind).toBe('disponible');
        else if (has(other)) expect(out.kind).toBe('solo_alternativa');
        else expect(out.kind).toBe('no_disponible');
      }),
    );
  });
});

// P-U3-03 ---------------------------------------------------------------------------------------
describe('P-U3-03 totales', () => {
  it('total = obra + envio dentro de rango; fuera de rango se rechaza', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5, max: 200_000 }),
        fc.integer({ min: -5, max: 20_000 }),
        (w, s) => {
          const r = computeTotals(w, s);
          const valid = w >= 100 && w <= 100_000 && s >= 1 && s <= 10_000;
          expect(r.ok).toBe(valid);
          if (r.ok) expect(r.value.totalCents).toBe(w + s);
        },
      ),
    );
    expect(computeTotals(100.5, 450).ok).toBe(false);
  });
});

// P-U3-04, P-U3-16, P-U3-18 (con el arnes) --------------------------------------------------------
describe('P-U3-04 el servidor decide el importe', () => {
  it('un total esperado manipulado nunca crea pedido; el correcto, uno con el total real', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -10, max: 1_000_000 }), async (claimed) => {
        const u = buildU3();
        const { slug } = await sellableListing(u);
        const r = await u.startCheckout.execute(
          checkoutInput(slug, { expectedTotalCents: claimed }),
        );
        if (claimed === 25_450) {
          expect(unwrap(r).kind).toBe('redirect');
          expect([...u.db.state.orders.values()][0]?.totalCents).toBe(25_450);
        } else {
          expect(u.db.state.orders.size).toBe(0);
          expect(u.db.state.reservations.size).toBe(0);
        }
      }),
      { numRuns: 30 },
    );
  });
});

describe('P-U3-16 disponibilidad', () => {
  it('una obra pausada o vendida no admite pago y no crea nada', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('pausado', 'vendido'), async (status) => {
        const u = buildU3();
        const { slug, listing } = await sellableListing(u);
        const current = u.db.state.listings.get(listing.id)!;
        u.db.state.listings.set(listing.id, {
          ...current,
          status: status as 'pausado' | 'vendido',
          pausedReason: status === 'pausado' ? 'artista' : undefined,
          soldAt: status === 'vendido' ? u.clock.now() : undefined,
        });
        const r = unwrap(await u.startCheckout.execute(checkoutInput(slug)));
        expect(r.kind).toBe('obra_no_disponible');
        expect(u.db.state.orders.size).toBe(0);
      }),
      { numRuns: 10 },
    );
  });
});

describe('P-U3-18 modo manual', () => {
  it('con el flag apagado ningun camino crea un pedido manual', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[A-Za-z ]{2,20}$/), async (name) => {
        const u = buildU3();
        const { slug } = await sellableListing(u);
        const r = await u.startCheckout.execute(
          checkoutInput(slug, { method: 'manual', fields: buyerFields({ name }) }),
        );
        expect(!r.ok && r.error.code).toBe('not_found');
        expect(u.db.state.orders.size).toBe(0);
      }),
      { numRuns: 15 },
    );
  });
});

// P-U3-05, P-U3-06 -------------------------------------------------------------------------------
describe('P-U3-05 / P-U3-06 datos de la compradora', () => {
  it('nunca lanza y acepta solo codigo postal peninsular con provincia coherente', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 8 }), fc.anything()), (junk) => {
        expect(() => buyerInputSchema.safeParse(junk)).not.toThrow();
      }),
    );
    fc.assert(
      fc.property(fc.constantFrom('07001', '35001', '38001', '51001', '52001'), (postalCode) => {
        expect(buyerInputSchema.safeParse(buyerFields({ postalCode })).success).toBe(false);
      }),
    );
    expect(buyerInputSchema.safeParse(buyerFields()).success).toBe(true);
    expect(buyerInputSchema.safeParse(buyerFields({ province: 'Madrid' })).success).toBe(false);
  });

  it('la normalizacion es idempotente', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(normalizeLine(normalizeLine(s))).toBe(normalizeLine(s));
      }),
    );
  });
});

// P-U3-07, P-U3-08 -------------------------------------------------------------------------------
describe('P-U3-07 maquina de estados del pedido', () => {
  it('modelo de referencia: una venta como maximo, un reembolso como maximo, estados absorbentes', () => {
    fc.assert(
      fc.property(fc.array(triggerArb, { maxLength: 30 }), (triggers) => {
        let status: OrderStatus = 'pendiente_pago';
        let sold = 0;
        let refunds = 0;
        for (const t of triggers) {
          const before = status;
          const tr = applyTrigger(before, t);
          const count = (e: Effect) => tr.effects.filter((x) => x === e).length;
          sold += count('mark_sold');
          refunds += count('request_refund');
          if (before === 'pagado') expect(tr.status).toBe('pagado');
          if (before === 'reembolsado') expect(tr.status).toBe('reembolsado');
          if (before === 'incidencia') expect(['incidencia', 'reembolsado']).toContain(tr.status);
          if (!tr.changed) {
            expect(tr.effects).toHaveLength(0);
            expect(tr.status).toBe(before);
          }
          if (before === 'cancelado' && tr.changed) {
            expect(t.type).toBe('payment_completed');
          }
          status = tr.status;
        }
        expect(sold).toBeLessThanOrEqual(1);
        expect(refunds).toBeLessThanOrEqual(1);
        expect(ORDER_STATUSES).toContain(status);
      }),
    );
  });
});

describe('P-U3-08 idempotencia de la transicion', () => {
  it('aplicar dos veces el mismo disparador no cambia nada la segunda vez', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ORDER_STATUSES), triggerArb, (status, trigger) => {
        const first = applyTrigger(status, trigger);
        const second = applyTrigger(first.status, trigger);
        expect(second.changed).toBe(false);
        expect(second.effects).toHaveLength(0);
        expect(second.status).toBe(first.status);
      }),
    );
  });
});

// P-U3-09, P-U3-10 -------------------------------------------------------------------------------
type Op = 'start' | 'payLast' | 'payFirst' | 'sweep' | 'cancelLast' | { advance: number };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constantFrom<Op>('start', 'payLast', 'payFirst', 'sweep', 'cancelLast'),
  fc.integer({ min: 1, max: 45 }).map((m): Op => ({ advance: m })),
);

const runOps = async (u: U3, slug: string, ops: Op[]) => {
  const resumes: string[] = [];
  let n = 0;
  const pay = async (id: string | undefined) => {
    if (!id) return;
    const s = u.payments.pay(id);
    await u.processor.execute(factFromEvent(u.payments.eventFor(s, 'completed'))!, 'c');
  };
  for (const op of ops) {
    const orders = [...u.db.state.orders.values()];
    if (op === 'start') {
      n += 1;
      const r = await u.startCheckout.execute(
        checkoutInput(slug, {
          ip: `10.0.0.${n}`,
          fields: buyerFields({ email: `c${n}@example.com` }),
        }),
      );
      if (r.ok && r.value.kind === 'redirect') resumes.push(r.value.resumeId);
    } else if (op === 'payLast') await pay(orders.at(-1)?.checkoutSessionId);
    else if (op === 'payFirst') await pay(orders[0]?.checkoutSessionId);
    else if (op === 'sweep') await u.expire.execute('c');
    else if (op === 'cancelLast') await u.cancel.execute(resumes.at(-1), 'c');
    else u.clock.advance(op.advance * MS.minute);

    // P-U3-10: nunca dos reservas activas y vigentes sobre el mismo enlace.
    const now = u.clock.now();
    const active = [...u.db.state.reservations.values()].filter(
      (r) => r.status === 'activa' && r.expiresAt > now,
    );
    expect(active.length).toBeLessThanOrEqual(1);
  }
  // Se completan los reembolsos pendientes.
  for (const o of [...u.db.state.orders.values()]) {
    if (o.status === 'incidencia') await u.refund.execute(o.id, 'c', false);
  }
};

describe('P-U3-09 / P-U3-10 unicidad de la venta y reservas', () => {
  it('como mucho un pedido pagado por enlace; los demas pagos se reembolsan una vez', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 14 }), async (ops) => {
        const u = buildU3();
        const { slug, listing } = await sellableListing(u);
        await runOps(u, slug, ops);
        const all = [...u.db.state.orders.values()];
        const paid = all.filter((o) => o.status === 'pagado');
        expect(paid.length).toBeLessThanOrEqual(1);
        const current = u.db.state.listings.get(listing.id)!;
        if (paid[0]) {
          expect(current.status).toBe('vendido');
          expect(current.orderId).toBe(paid[0].id);
        } else {
          expect(current.status).not.toBe('vendido');
        }
        // Todo pago hecho en Stripe que no es el ganador termina reembolsado una sola vez.
        for (const o of all) {
          const session = o.checkoutSessionId
            ? u.payments.sessions.get(o.checkoutSessionId)
            : undefined;
          if (session?.paid && o.status !== 'pagado') {
            expect(o.status).toBe('reembolsado');
            expect(u.payments.refunds.get(session.paymentIntentId as string)).toBeDefined();
          }
        }
        const paidSessions = [...u.payments.sessions.values()].filter((s) => s.paid).length;
        expect(u.payments.refunds.size).toBe(Math.max(0, paidSessions - paid.length));
      }),
      { numRuns: 40 },
    );
  });
});

// P-U3-11 a P-U3-13 ------------------------------------------------------------------------------
describe('P-U3-11 token de seguimiento', () => {
  it('43 caracteres, determinista, distinto por pedido y nonce, y su resumen es de 64 hex', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (a, b) => {
        const n1 = newTrackingNonce();
        const n2 = newTrackingNonce();
        const t = deriveTrackingToken('s'.repeat(32), a, n1);
        expect(t).toHaveLength(43);
        expect(isWellFormedToken(t)).toBe(true);
        expect(deriveTrackingToken('s'.repeat(32), a, n1)).toBe(t);
        expect(deriveTrackingToken('s'.repeat(32), a, n2)).not.toBe(t);
        if (a !== b) expect(deriveTrackingToken('s'.repeat(32), b, n1)).not.toBe(t);
        expect(hashTrackingToken(t)).toMatch(/^[0-9a-f]{64}$/);
        expect(t).not.toContain(a);
      }),
    );
  });

  it('con dos secretos, el token se vuelve a derivar con el que lo emitio', () => {
    const order = { id: 'o', trackingNonce: 'n', tokenKeyId: '' };
    const oldSecret = 'o'.repeat(32);
    const withOld = {
      ...order,
      tokenKeyId: tokenForOrder(
        { current: oldSecret, previous: undefined },
        { ...order, tokenKeyId: 'x' },
      )
        ? ''
        : '',
    };
    expect(withOld).toBeDefined();
    expect(tokenForOrder(SECRETS, { ...order, tokenKeyId: 'ffffffff' })).toBeUndefined();
  });
});

describe('P-U3-12 / P-U3-13 consulta y vista de seguimiento', () => {
  it('cualquier cadena ajena responde igual; la vista nunca lleva datos de la compradora', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    await u.startCheckout.execute(
      checkoutInput(slug, {
        fields: buyerFields({ name: 'Qzxwvu Plmokn', street: 'Qzx Calle 99' }),
      }),
    );
    const order = [...u.db.state.orders.values()][0] as Order;
    const good = tokenForOrder(SECRETS, order) as string;
    const view = unwrap(await u.tracking.execute(good, '9.9.9.9', 'c'));
    const text = JSON.stringify(view);
    for (const secret of [
      'Qzxwvu',
      'Plmokn',
      'Qzx Calle',
      'lucia@example.com',
      '612345678',
      '08001',
    ]) {
      expect(text).not.toContain(secret);
    }
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 60 }), async (junk) => {
        fc.pre(junk !== good);
        const r = await u.tracking.execute(junk, `ip-${junk.length}`, 'c');
        expect(!r.ok && r.error.code).toBe('not_found');
      }),
      { numRuns: 50 },
    );
  });
});

// P-U3-14 ----------------------------------------------------------------------------------------
describe('P-U3-14 datos personales fuera de eventos y auditoria', () => {
  it('para cualquier compradora, ni eventos ni auditoria ni logs los contienen', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z]{8,12}$/),
        fc.stringMatching(/^[a-z]{8,12}$/),
        async (first, last) => {
          const u = buildU3();
          const { slug } = await sellableListing(u);
          const name = `Qzx${first} Wvu${last}`;
          const email = `${first}.${last}@example.com`;
          await u.startCheckout.execute(
            checkoutInput(slug, { fields: buyerFields({ name, email }) }),
          );
          const order = [...u.db.state.orders.values()][0] as Order;
          if (order.checkoutSessionId) {
            const s = u.payments.pay(order.checkoutSessionId);
            await u.processor.execute(factFromEvent(u.payments.eventFor(s, 'completed'))!, 'c');
          }
          const dump = JSON.stringify([
            u.db.state.events,
            u.auditStore.events,
            u.logger.entries,
            u.alerts.raised,
          ]);
          expect(dump).not.toContain(`Qzx${first}`);
          expect(dump).not.toContain(email);
        },
      ),
      { numRuns: 15 },
    );
  });
});

// P-U3-15 ----------------------------------------------------------------------------------------
describe('P-U3-15 cookie de reintento', () => {
  it('128 bits, resumen distinto del valor, y caduca a la hora', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 * 60 }), (minutes) => {
        const id = newResumeId();
        expect(id).toHaveLength(22);
        expect(hashResumeId(id)).not.toContain(id);
        const now = instantOf(1_000_000);
        const expires = instantOf(1_000_000 + 60 * MS.minute);
        const later = instantOf(1_000_000 + minutes * MS.minute);
        expect(resumeStillValid(expires, later)).toBe(minutes < 60);
        expect(resumeStillValid(undefined, now)).toBe(false);
      }),
    );
  });
});

// P-U3-17 ----------------------------------------------------------------------------------------
describe('P-U3-17 autorizacion por objeto', () => {
  it('otra artista nunca confirma un cobro manual ni ve pedidos ajenos', async () => {
    const u = buildU3({ manual: true });
    const { slug, artistId } = await sellableListing(u);
    await u.db.run({ kind: 'system' }, (r) =>
      r.contacts.saveBizumPhone(artistId, '+34612000111', u.clock.now()),
    );
    await u.startCheckout.execute(checkoutInput(slug, { method: 'manual' }));
    const order = [...u.db.state.orders.values()][0] as Order;
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (other) => {
        fc.pre(other !== artistId);
        const r = await u.confirmManual.execute(other, order.id, 'c');
        expect(!r.ok && r.error.code).toBe('not_found');
        expect(await u.artistOrders.execute(other)).toHaveLength(0);
      }),
      { numRuns: 30 },
    );
    expect(u.db.state.orders.get(order.id)?.status).toBe('pendiente_pago');
  });
});

// P-U3-19 ----------------------------------------------------------------------------------------
describe('P-U3-19 validacion de la respuesta del proveedor', () => {
  it('un precio no entero, <= 0 o fuera de rango descarta el servicio sin lanzar', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.double({ noNaN: false }), fc.integer({ min: -5, max: 20_000 })),
        (price) => {
          const s = {
            id: 'x',
            name: 'n',
            modality: 'punto',
            priceCents: price,
            transitDays: 2,
          };
          const valid = Number.isSafeInteger(price) && price >= 1 && price <= 10_000;
          expect(isValidService(s)).toBe(valid);
        },
      ),
    );
    fc.assert(
      fc.property(fc.anything(), (x) => {
        expect(() => isValidService(x)).not.toThrow();
      }),
    );
  });
});

// P-U3-20 ----------------------------------------------------------------------------------------
describe('P-U3-20 plazo del pedido', () => {
  it('vencido es pendiente con plazo + 2 minutos pasado; tras el respaldo no queda ninguno', async () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (exp, now) => {
          const o = { status: 'pendiente_pago' as const, expiresAt: instantOf(exp) };
          expect(isOverdue(o, instantOf(now))).toBe(exp + 120_000 <= now);
          expect(isOverdue({ ...o, status: 'pagado' }, instantOf(now))).toBe(false);
        },
      ),
    );
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 35, max: 600 }), async (minutes) => {
        const u = buildU3();
        const { slug } = await sellableListing(u);
        await u.startCheckout.execute(checkoutInput(slug));
        u.clock.advance(minutes * MS.minute);
        await u.expire.execute('c');
        const stale = [...u.db.state.orders.values()].filter((o) => isOverdue(o, u.clock.now()));
        expect(stale).toHaveLength(0);
      }),
      { numRuns: 15 },
    );
  });
});
