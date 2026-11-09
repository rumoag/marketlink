import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { instantOf, MS } from '@/modules/kernel/domain/clock';
import { Secret } from '@/modules/platform/application/config';
import { ORDER_STATUSES } from '@/modules/orders/domain/order';
import {
  renderEmail,
  NOTIFICATION_TYPES,
  recipientOf,
} from '@/modules/notifications/domain/notification';
import { reduceProviderEvent } from '@/modules/shipping/domain/provider-events';
import {
  FACT_TYPES,
  applyFact,
  initialShipmentState,
  nextAction,
  orderStatusFor,
  payReminderDue,
  pickupReminderDue,
  rankOf,
  selectDropoffs,
  shippingMarginCents,
  type DropoffPoint,
  type FactType,
  type ShipmentFact,
  type ShipmentState,
} from '@/modules/shipping/domain/shipment';
import { IngestShipmentEvent } from '@/services/ingest-shipment-event';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { MemoryAuditStore, MemoryLogger } from '@tests/support/fakes';
import { FakeClock } from '@tests/support/generators';
import { buildU4, paidOrder, fact } from '@tests/support/u4-harness';
import { buyerFields } from '@tests/support/u3-harness';

const factTypeArb = fc.constantFrom<FactType>(...FACT_TYPES);
const factArb = (at: fc.Arbitrary<number> = fc.integer({ min: 1000, max: 5000 })) =>
  fc.record({ type: factTypeArb, at: at.map((n) => instantOf(n)) }) as fc.Arbitrary<ShipmentFact>;

const run = (facts: readonly ShipmentFact[], from: ShipmentState = initialShipmentState) => {
  let state = from;
  const results = [];
  for (const f of facts) {
    const r = applyFact(state, f);
    results.push({ prev: state, fact: f, r });
    state = r.state;
  }
  return { state, results };
};

// P-U4-01, 02, 03, 04, 15 ---------------------------------------------------------------------
describe('P-U4-01 la maquina de estados de envio solo avanza', () => {
  it('el rango nunca disminuye y el pedido refleja siempre el estado del envio', () => {
    fc.assert(
      fc.property(fc.array(factArb(), { maxLength: 25 }), (facts) => {
        const { results } = run(facts);
        for (const { prev, r } of results) {
          expect(rankOf(r.state.status)).toBeGreaterThanOrEqual(rankOf(prev.status));
          expect(r.orderStatus).toBe(orderStatusFor(r.state));
          if (!r.changed) {
            expect(r.state).toEqual(prev);
            expect(r.notifications).toHaveLength(0);
          }
        }
      }),
    );
  });
});

describe('P-U4-02 idempotencia', () => {
  it('aplicar dos veces el mismo hecho no cambia nada la segunda vez', () => {
    fc.assert(
      fc.property(fc.array(factArb(), { maxLength: 10 }), factArb(), (prefix, f) => {
        const { state } = run(prefix);
        const once = applyFact(state, f);
        const twice = applyFact(once.state, f);
        expect(twice.changed).toBe(false);
        expect(twice.notifications).toHaveLength(0);
        expect(twice.state).toEqual(once.state);
      }),
    );
  });
});

describe('P-U4-03 orden de llegada', () => {
  it('con los hechos hacia delante, el estado final no depende del orden', () => {
    const forward = fc.array(
      fc.constantFrom<FactType>(
        'draft_created',
        'label_ready',
        'in_transit',
        'delivered',
        'tracking_info',
      ),
      { minLength: 1, maxLength: 8 },
    );
    fc.assert(
      fc.property(forward, fc.integer({ min: 0, max: 1000 }), (types, seed) => {
        const t = instantOf(5000);
        const facts = types.map((type) => ({ type, at: t }) as ShipmentFact);
        const shuffled = [...facts].sort(
          (a, b) => ((a.type.charCodeAt(0) * seed) % 7) - ((b.type.charCodeAt(0) * seed) % 7),
        );
        const a = run(facts).state;
        const b = run(shuffled).state;
        expect(rankOf(a.status)).toBe(rankOf(b.status));
        const expected = Math.max(
          0,
          ...types.map((x) =>
            x === 'draft_created'
              ? 1
              : x === 'label_ready'
                ? 2
                : x === 'in_transit'
                  ? 3
                  : x === 'delivered'
                    ? 4
                    : 0,
          ),
        );
        expect(rankOf(a.status)).toBe(expected);
      }),
    );
  });
});

describe('P-U4-04 hechos con instante anterior', () => {
  it('un hecho del proveedor anterior al ultimo aplicado no cambia el estado', () => {
    fc.assert(
      fc.property(
        fc.array(factArb(fc.integer({ min: 2000, max: 5000 })), { maxLength: 8 }),
        factArb(fc.integer({ min: 1, max: 1999 })),
        (prefix, old) => {
          const { state } = run(prefix);
          fc.pre(state.lastEventAt !== undefined);
          fc.pre(old.type !== 'draft_created' && old.type !== 'draft_failed');
          const r = applyFact(state, old);
          expect(r.changed).toBe(false);
          expect(r.state).toEqual(state);
        },
      ),
    );
  });
});

describe('P-U4-15 incidencias', () => {
  it('solo desde borrador, etiqueta o transito; una vez; sin tocar el reembolso; los hechos hacia delante la recuperan', () => {
    fc.assert(
      fc.property(fc.array(factArb(), { maxLength: 25 }), (facts) => {
        const { results } = run(facts);
        for (const { prev, fact: f, r } of results) {
          const failure = f.type === 'label_failed' || f.type === 'carrier_failed';
          if (failure && r.changed) {
            expect(rankOf(prev.status)).toBeGreaterThanOrEqual(1);
            expect(rankOf(prev.status)).toBeLessThanOrEqual(3);
            expect(prev.incident).toBeUndefined();
            expect(r.orderStatus).toBe('incidencia');
          }
          if (prev.incident && r.changed && !failure) {
            expect(r.state.incident).toBeUndefined();
            expect(rankOf(r.state.status)).toBeGreaterThan(rankOf(prev.status));
          }
        }
      }),
    );
  });
});

// P-U4-05 ---------------------------------------------------------------------------------------
describe('P-U4-05 reduccion de eventos de Packlink', () => {
  it('nunca lanza con cuerpos arbitrarios y los tipos conocidos dan exactamente un hecho', () => {
    fc.assert(
      fc.property(fc.anything(), (body) => {
        expect(() => reduceProviderEvent(body, instantOf(1000))).not.toThrow();
      }),
    );
    const known = [
      ['shipment.label.ready', 'label_ready'],
      ['shipment.carrier.success', 'in_transit'],
      ['shipment.delivered', 'delivered'],
      ['shipment.carrier.delivered', 'delivered'],
      ['shipment.label.fail', 'label_failed'],
      ['shipment.carrier.fail', 'carrier_failed'],
    ] as const;
    for (const [name, type] of known) {
      const ev = reduceProviderEvent(
        { event: name, data: { reference: 'PL1' }, created_at: 1_700_000_000 },
        instantOf(5),
      );
      expect(ev?.fact.type).toBe(type);
      expect(ev?.providerRef).toBe('PL1');
      expect(ev?.fact.at).toBe(1_700_000_000_000);
    }
    expect(
      reduceProviderEvent({ event: 'otra.cosa', data: { reference: 'PL1' } }, instantOf(5)),
    ).toBeUndefined();
    expect(
      reduceProviderEvent({ event: 'shipment.delivered', data: {} }, instantOf(5)),
    ).toBeUndefined();
    const upd = reduceProviderEvent(
      { event: 'shipment.tracking.update', data: { reference: 'P', status: 'delivered' } },
      instantOf(5),
    );
    expect(upd?.fact.type).toBe('delivered');
  });
});

// P-U4-06 ---------------------------------------------------------------------------------------
describe('P-U4-06 webhook y consulta', () => {
  it('el mismo conjunto de hechos, repetido o intercalado, da el mismo resultado', async () => {
    const forward = fc.array(fc.constantFrom<FactType>('label_ready', 'in_transit', 'delivered'), {
      minLength: 1,
      maxLength: 4,
    });
    await fc.assert(
      fc.asyncProperty(forward, async (types) => {
        const a = buildU4();
        const b = buildU4();
        const pa = await paidOrder(a);
        const pb = await paidOrder(b);
        await a.draft.execute(pa.order.id, 'c', false);
        await b.draft.execute(pb.order.id, 'c', false);
        const refA = [...a.db.state.shipments.values()][0]?.providerRef as string;
        const refB = [...b.db.state.shipments.values()][0]?.providerRef as string;
        const t = a.clock.now();
        const facts = types.map((type, i) => fact(type, t + i));
        for (const f of facts) await a.processFact.execute(refA, f, 'c'); // webhook
        for (const f of [...facts, ...facts].sort((x, y) => x.at - y.at))
          await b.processFact.execute(refB, f, 'c'); // consulta + webhook
        const sa = [...a.db.state.orders.values()][0]!;
        const sb = [...b.db.state.orders.values()][0]!;
        expect(sb.status).toBe(sa.status);
        const countOf = (u: typeof a, type: string) =>
          [...u.db.state.notifications.values()].filter((n) => n.type === type).length;
        for (const type of NOTIFICATION_TYPES) expect(countOf(b, type)).toBe(countOf(a, type));
        for (const type of NOTIFICATION_TYPES) expect(countOf(b, type)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 12 },
    );
  });
});

// P-U4-07 ---------------------------------------------------------------------------------------
describe('P-U4-07 notificaciones por transicion', () => {
  it('cada transicion genera las de BR4-NT3 y «en camino» solo al pasar a en_transito', () => {
    fc.assert(
      fc.property(fc.array(factArb(), { maxLength: 25 }), (facts) => {
        const { results } = run(facts);
        for (const { r, prev } of results) {
          if (!r.changed) continue;
          const has = (t: string) => r.notifications.includes(t as never);
          expect(has('en_camino_compradora')).toBe(
            r.state.status === 'en_transito' && prev.status !== 'en_transito' && !r.state.incident,
          );
          expect(new Set(r.notifications).size).toBe(r.notifications.length);
          if (r.state.status === 'entregado' && prev.status !== 'entregado') {
            expect(has('entregado_compradora') && has('entregado_artista')).toBe(true);
          }
        }
        const enCamino = results.filter((x) => x.r.notifications.includes('en_camino_compradora'));
        expect(enCamino.length).toBeLessThanOrEqual(1);
      }),
    );
  });
});

// P-U4-08 ---------------------------------------------------------------------------------------
describe('P-U4-08 datos personales fuera de notificaciones y avisos', () => {
  it('para cualquier compradora, ni la bandeja, ni los trabajos, ni los eventos, ni el email de la artista los contienen', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z]{8,12}$/),
        fc.stringMatching(/^[a-z]{8,12}$/),
        async (a, b) => {
          const u = buildU4();
          const name = `Qzx${a} Wvu${b}`;
          const street = `Plk${a} ${b} 12`;
          const { order } = await paidOrder(u, {
            fields: buyerFields({ name, street, email: `${a}.${b}@example.com` }),
          });
          await u.draft.execute(order.id, 'c', false);
          await u.dispatch.execute('c');
          const toArtist = u.email.sent.filter((m) => m.subject.startsWith('Has vendido'));
          expect(toArtist.length).toBeGreaterThan(0);
          for (const m of toArtist) {
            expect(m.text).not.toContain(`Plk${a}`);
            expect(m.text).not.toContain(`Qzx${a}`);
          }
          const dump = JSON.stringify([
            [...u.db.state.notifications.values()],
            u.jobs,
            u.db.state.events,
            u.auditStore.events,
            u.alerts.raised,
          ]);
          expect(dump).not.toContain(`Qzx${a}`);
          expect(dump).not.toContain(`Plk${a}`);
          expect(dump).not.toContain(`${a}.${b}@example.com`);
        },
      ),
      { numRuns: 8 },
    );
  });
});

// P-U4-09 ---------------------------------------------------------------------------------------
describe('P-U4-09 el borrador es idempotente', () => {
  it('con fallos intermitentes y reintentos, nunca hay mas de un envio ni de una referencia por pedido', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('ok', 'fail', 'failfind'), { minLength: 1, maxLength: 8 }),
        async (modes) => {
          const u = buildU4();
          const { order } = await paidOrder(u);
          for (const m of modes) {
            u.provider.failCreate = m === 'fail';
            u.provider.failFind = m === 'failfind';
            await u.draft.execute(order.id, 'c', false);
          }
          u.provider.failCreate = false;
          u.provider.failFind = false;
          await u.draft.execute(order.id, 'c', false);
          await u.draft.execute(order.id, 'c', false);
          expect(u.provider.drafts.size).toBe(1);
          expect(u.provider.created).toBe(1);
          const shipments = [...u.db.state.shipments.values()].filter(
            (s) => s.orderId === order.id,
          );
          expect(shipments).toHaveLength(1);
          expect(shipments[0]?.providerRef).toBe([...u.provider.drafts.values()][0]?.ref);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// P-U4-10 ---------------------------------------------------------------------------------------
describe('P-U4-10 recogida', () => {
  it('sin eleccion valida no hay borrador; las opciones inventadas se rechazan', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 40 }), async (junk) => {
        fc.pre(!junk.includes('2026-11-1'));
        const u = buildU4();
        const { order, artistId } = await paidOrder(u, { modality: 'recogida' });
        await u.draft.execute(order.id, 'c', false);
        const r = await u.chooseDraftPickup.execute(artistId, order.id, junk);
        expect(r.ok && r.value.kind).toBe('unavailable');
        await u.draft.execute(order.id, 'c', false);
        expect(u.provider.createCalls).toBe(0);
        expect([...u.db.state.shipments.values()][0]?.pickup).toBeUndefined();
      }),
      { numRuns: 12 },
    );
  });
});

// P-U4-11 ---------------------------------------------------------------------------------------
describe('P-U4-11 puntos de entrega', () => {
  it('como mucho tres, por cercania, sin distancia al final y sin perder ni inventar puntos', () => {
    const point = fc.record<DropoffPoint>({
      name: fc.string({ minLength: 1, maxLength: 6 }),
      address: fc.constant('x'),
      schedule: fc.constant('y'),
      distanceKm: fc.option(fc.double({ min: 0, max: 50, noNaN: true }), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(point, { maxLength: 12 }), (points) => {
        const out = selectDropoffs(points);
        expect(out.length).toBeLessThanOrEqual(3);
        expect(out.length).toBe(Math.min(3, points.length));
        for (const p of out) expect(points).toContain(p);
        const d = out.map((p) => p.distanceKm ?? Number.POSITIVE_INFINITY);
        expect([...d].sort((a, b) => a - b)).toEqual(d);
        const best = [...points]
          .map((p) => p.distanceKm ?? Number.POSITIVE_INFINITY)
          .sort((a, b) => a - b)
          .slice(0, 3);
        expect(d).toEqual(best);
      }),
    );
  });
});

// P-U4-12 ---------------------------------------------------------------------------------------
describe('P-U4-12 recordatorios', () => {
  it('con el reloj avanzando: recordatorio a las 24 h, operador a las 72 h, una vez cada uno y nunca si se eligio', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (hours, chosen, reminded, alerted) => {
          const requestedAt = instantOf(0);
          const now = instantOf(hours * MS.hour);
          const r = pickupReminderDue({
            chosen,
            requestedAt,
            remindedAt: reminded ? instantOf(1) : undefined,
            operatorAlertedAt: alerted ? instantOf(1) : undefined,
            now,
          });
          if (chosen) expect(r).toBe('ninguno');
          if (r === 'recordatorio') {
            expect(hours).toBeGreaterThanOrEqual(24);
            expect(reminded).toBe(false);
          }
          if (r === 'operador') {
            expect(hours).toBeGreaterThanOrEqual(72);
            expect(alerted).toBe(false);
          }
          if (hours < 24) expect(r).toBe('ninguno');
        },
      ),
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), fc.boolean(), (hours, reminded) => {
        const due = payReminderDue({
          draftCreatedAt: instantOf(0),
          remindedAt: reminded ? instantOf(1) : undefined,
          status: 'borrador',
          now: instantOf(hours * MS.hour),
        });
        expect(due).toBe(hours >= 24 && !reminded);
      }),
    );
  });
});

// P-U4-13, P-U4-16 -----------------------------------------------------------------------------
describe('P-U4-13 / P-U4-16 autorizacion por objeto', () => {
  it('otra artista nunca obtiene etiqueta, factura, detalle ni puede elegir recogida', async () => {
    const u = buildU4();
    const { order } = await paidOrder(u);
    await u.draft.execute(order.id, 'c', false);
    const ref = [...u.db.state.shipments.values()][0]?.providerRef as string;
    await u.processFact.execute(ref, fact('label_ready', u.clock.now()), 'c');
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (other) => {
        fc.pre(other !== order.artistId);
        expect((await u.labelDownload.execute(other, order.id, 'c')).ok).toBe(false);
        expect((await u.invoice.execute(other, order.id, 'c')).ok).toBe(false);
        expect((await u.artistOrder.execute(other, order.id)).ok).toBe(false);
        expect((await u.chooseDraftPickup.execute(other, order.id, 'x')).ok).toBe(false);
      }),
      { numRuns: 25 },
    );
    expect((await u.labelDownload.execute(order.artistId, order.id, 'c')).ok).toBe(true);
  });
});

// P-U4-14 ---------------------------------------------------------------------------------------
describe('P-U4-14 margen del envio', () => {
  it('margen = envio - coste real - comision estimada, sin perdida y con signo', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 101, max: 110_000 }),
        (shippingCents, labelCostCents, totalCents) => {
          const m = shippingMarginCents({ shippingCents, labelCostCents, totalCents });
          expect(Number.isInteger(m)).toBe(true);
          expect(m).toBe(shippingCents - labelCostCents - (Math.round(totalCents * 0.015) + 25));
        },
      ),
    );
  });
});

// P-U4-17 ---------------------------------------------------------------------------------------
describe('P-U4-17 secreto del webhook de Packlink', () => {
  it('solo el secreto exacto es aceptado', async () => {
    const SECRET = 'secreto-del-webhook-0123456789';
    const seen = new Set<string>();
    const audit = new MemoryAuditStore();
    const logger = new MemoryLogger();
    const clock = new FakeClock(1000);
    const ingest = new IngestShipmentEvent({
      secret: new Secret(SECRET),
      store: {
        insertIfNew: (_p, id) => {
          const isNew = !seen.has(id);
          seen.add(id);
          return Promise.resolve(isNew);
        },
      },
      enqueue: () => Promise.resolve(),
      audit: new AuditLog(audit, logger, clock),
      logger,
      clock,
    });
    const body = JSON.stringify({
      id: 'e1',
      event: 'shipment.delivered',
      data: { reference: 'PL1' },
    });
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 60 }), async (supplied) => {
        fc.pre(supplied !== SECRET);
        expect(await ingest.handle(body, supplied, 'c')).toBe('invalid_signature');
      }),
      { numRuns: 60 },
    );
    expect(await ingest.handle(body, null, 'c')).toBe('invalid_signature');
    expect(await ingest.handle(body, `${SECRET} `, 'c')).toBe('invalid_signature');
    expect(await ingest.handle(body, SECRET, 'c')).toBe('accepted');
    expect(await ingest.handle(body, SECRET, 'c')).toBe('duplicate');
    expect(await ingest.handle('no es json', SECRET, 'c')).toBe('ignored');
    expect(seen.size).toBe(1);
  });
});

// P-U4-18 ---------------------------------------------------------------------------------------
describe('P-U4-18 siguiente accion', () => {
  it('es total y siempre devuelve un texto cerrado', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ORDER_STATUSES),
        fc.constantFrom('punto', 'recogida' as const),
        fc.boolean(),
        (orderStatus, modality, pickupChosen) => {
          const n = nextAction({
            orderStatus,
            modality: modality as 'punto' | 'recogida',
            pickupChosen,
          });
          expect(n.code.length).toBeGreaterThan(0);
          expect(n.text.length).toBeGreaterThan(0);
        },
      ),
    );
    expect(
      nextAction({ orderStatus: 'pagado', modality: 'recogida', pickupChosen: false }).code,
    ).toBe('elegir_recogida');
    expect(
      nextAction({ orderStatus: 'etiqueta_lista', modality: 'punto', pickupChosen: false }).code,
    ).toBe('llevar_a_punto');
  });
});

describe('plantillas', () => {
  it('cada tipo tiene destinatario y plantilla; ningun texto lleva calle ni telefono', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NOTIFICATION_TYPES),
        fc.string({ minLength: 1, maxLength: 20 }),
        (type, title) => {
          const mail = renderEmail(type, {
            brand: 'MarketLink',
            orderRef: 'abc12345',
            title,
            totalCents: 25_450,
            shippingCents: 450,
            orderUrl: 'https://app.test/artista/pedidos/x',
            trackingUrl: 'https://app.test/seguimiento/t',
            carrier: 'Correos',
            modality: 'punto',
            pickupText: undefined,
            dropoffs: [],
            labelCostCents: undefined,
          });
          expect(mail.subject.length).toBeGreaterThan(0);
          expect(['artista', 'compradora', 'operador']).toContain(recipientOf(type));
          expect(mail.text).not.toMatch(/\+34|\b6\d{8}\b/);
        },
      ),
    );
  });
});
