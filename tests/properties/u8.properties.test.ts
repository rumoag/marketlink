import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  acceptedServices,
  buildOptions,
  checkSelection,
  compareServices,
  defaultOption,
  groupByDestination,
  pickHighlights,
  type DeliveryPoint,
  type ShippingService,
} from '@/modules/checkout/domain/quote';
import { instantOf } from '@/modules/kernel/domain/clock';
import {
  computeTotals,
  deliverySummary,
  purgePersonalData,
  type Modality,
  type Order,
} from '@/modules/orders/domain/order';
import { checkoutInput, buildU3, sellableListing } from '@tests/support/u3-harness';

/** Semilla impresa en cada fallo (NFR-U8-40): fast-check la muestra en el mensaje del error. */
const RUNS = { numRuns: 200 };

const modalityArb = fc.constantFrom<Modality>('punto', 'recogida');
const destinationArb = fc.constantFrom<'domicilio' | 'punto'>('domicilio', 'punto');

const serviceArb = fc.record<ShippingService>({
  id: fc.stringMatching(/^[0-9]{1,6}$/),
  name: fc.constant('Servicio'),
  carrier: fc.constantFrom('Correos', 'Seur', 'DHL', 'GLS'),
  modality: modalityArb,
  destination: destinationArb,
  priceCents: fc.integer({ min: 100, max: 3_000 }),
  transitDays: fc.integer({ min: 1, max: 10 }),
});

/** Identificadores unicos, como los de un proveedor real. */
const servicesArb = fc.uniqueArray(serviceArb, { selector: (s) => s.id, maxLength: 14 });
const originsArb = fc
  .subarray<Modality>(['punto', 'recogida'], { minLength: 1 })
  .map((o) => new Set(o));

const cheapest = (g: readonly ShippingService[]) => [...g].sort(compareServices)[0];
const fastest = (g: readonly ShippingService[]) =>
  [...g].sort((a, b) => a.transitDays - b.transitDays || compareServices(a, b))[0];

describe('P-U8-01 filtrado por origen aceptado', () => {
  it('los servicios compatibles son exactamente los de un origen aceptado', () => {
    fc.assert(
      fc.property(servicesArb, originsArb, (services, origins) => {
        const accepted = acceptedServices(services, origins);
        expect(accepted.every((s) => origins.has(s.modality))).toBe(true);
        const rejected = services.filter((s) => !accepted.includes(s));
        expect(rejected.every((s) => !origins.has(s.modality))).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('P-U8-02 particion por destino', () => {
  it('los dos grupos son una particion de los servicios compatibles', () => {
    fc.assert(
      fc.property(servicesArb, originsArb, (services, origins) => {
        const { groups } = buildOptions(services, origins);
        const all = [...groups.domicilio, ...groups.punto].map((s) => s.id).sort();
        const expected = acceptedServices(services, origins)
          .map((s) => s.id)
          .sort();
        expect(all).toEqual(expected);
        expect(groups.domicilio.every((s) => s.destination === 'domicilio')).toBe(true);
        expect(groups.punto.every((s) => s.destination === 'punto')).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('P-U8-03 destacadas', () => {
  it('hay hasta 3, distintas, del grupo y con la mas barata y la mas rapida', () => {
    fc.assert(
      fc.property(servicesArb, (services) => {
        const group = groupByDestination(services).domicilio;
        const picks = pickHighlights(group);
        expect(picks.length).toBeLessThanOrEqual(3);
        expect(new Set(picks.map((s) => s.id)).size).toBe(picks.length);
        expect(picks.every((p) => group.some((g) => g.id === p.id))).toBe(true);
        if (group.length > 0) {
          expect(picks.map((p) => p.id)).toContain(cheapest(group)?.id);
          expect(picks.map((p) => p.id)).toContain(fastest(group)?.id);
          expect(picks).toHaveLength(Math.min(3, group.length));
        } else {
          expect(picks).toEqual([]);
        }
      }),
      RUNS,
    );
  });
});

describe('P-U8-04 orden de las destacadas', () => {
  it('salen por precio ascendente', () => {
    fc.assert(
      fc.property(servicesArb, (services) => {
        const picks = pickHighlights(groupByDestination(services).punto);
        for (let i = 1; i < picks.length; i++) {
          expect(
            compareServices(picks[i - 1] as ShippingService, picks[i] as ShippingService),
          ).toBeLessThan(0);
        }
      }),
      RUNS,
    );
  });
});

describe('P-U8-05 la intermedia', () => {
  it('cuando existe no es la mas barata ni la mas rapida y equilibra precio y plazo', () => {
    fc.assert(
      fc.property(servicesArb, (services) => {
        const group = groupByDestination(services).domicilio;
        const cheap = cheapest(group) as ShippingService;
        const fast = fastest(group) as ShippingService;
        // Con la mas barata y la mas rapida distintas, la tercera es la intermedia.
        if (group.length < 3 || cheap.id === fast.id) return;
        const picks = pickHighlights(group);
        const middle = picks.filter((p) => p.id !== cheap.id && p.id !== fast.id);
        expect(middle).toHaveLength(1);
        const earlier = group.filter(
          (s) => s.id !== cheap.id && s.id !== fast.id && s.transitDays < cheap.transitDays,
        );
        if (earlier.length > 0) {
          // La de menor precio entre las que llegan antes que la mas barata.
          expect(middle[0]?.id).toBe(earlier.sort(compareServices)[0]?.id);
        }
      }),
      RUNS,
    );
  });
});

describe('P-U8-06 preseleccion', () => {
  it('es la mas barata de las destacadas a domicilio, o de punto si no hay domicilio', () => {
    fc.assert(
      fc.property(servicesArb, originsArb, (services, origins) => {
        const options = buildOptions(services, origins);
        const h = options.highlights;
        if (h.domicilio.length > 0) expect(options.preselected?.id).toBe(h.domicilio[0]?.id);
        else if (h.punto.length > 0) expect(options.preselected?.id).toBe(h.punto[0]?.id);
        else expect(options.preselected).toBeUndefined();
        expect(defaultOption(h)?.id).toBe(options.preselected?.id);
        if (h.domicilio.length > 0) {
          expect(options.preselected?.id).toBe(cheapest(options.groups.domicilio)?.id);
        }
      }),
      RUNS,
    );
  });
});

describe('P-U8-07 total', () => {
  it('es el precio de la obra mas el del servicio elegido', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 100_000 }), serviceArb, (work, service) => {
        const t = computeTotals(work, service.priceCents);
        expect(t.ok).toBe(true);
        if (t.ok) expect(t.value.totalCents).toBe(work + service.priceCents);
      }),
      RUNS,
    );
  });
});

describe('P-U8-08 aceptacion de una seleccion', () => {
  const pointsArb = fc.uniqueArray(
    fc.record<DeliveryPoint>({
      id: fc.stringMatching(/^[A-Z0-9]{1,8}$/),
      name: fc.constant('Punto'),
      address: fc.constant('Calle 1'),
      schedule: fc.constant('L-V'),
    }),
    { selector: (p) => p.id, maxLength: 12 },
  );

  it('se acepta si y solo si el servicio esta entre las opciones y el punto en la lista actual', () => {
    fc.assert(
      fc.property(
        servicesArb,
        originsArb,
        pointsArb,
        fc.stringMatching(/^[0-9]{1,6}$/),
        fc.option(fc.stringMatching(/^[A-Z0-9]{1,8}$/), { nil: undefined }),
        (services, origins, points, serviceId, pointId) => {
          const options = buildOptions(services, origins);
          const out = checkSelection(options, serviceId, pointId, points);
          const all = [...options.groups.domicilio, ...options.groups.punto];
          const service = all.find((s) => s.id === serviceId);
          if (service === undefined) {
            expect(out.kind).toBe('servicio_no_disponible');
          } else if (service.destination === 'domicilio') {
            expect(out.kind).toBe(pointId === undefined ? 'ok' : 'seleccion_invalida');
          } else if (pointId === undefined) {
            expect(out.kind).toBe('seleccion_invalida');
          } else {
            const inList = points.some((p) => p.id === pointId);
            expect(out.kind).toBe(inList ? 'ok' : 'punto_no_disponible');
          }
        },
      ),
      RUNS,
    );
  });

  it('un servicio de punto sin lista de puntos (proveedor caido) no se acepta', () => {
    const svc: ShippingService = {
      id: '1',
      name: 'x',
      carrier: 'Correos',
      modality: 'punto',
      destination: 'punto',
      priceCents: 400,
      transitDays: 3,
    };
    const options = buildOptions([svc], new Set<Modality>(['punto']));
    expect(checkSelection(options, '1', 'PT1', undefined).kind).toBe('punto_no_disponible');
  });
});

describe('P-U8-09 determinismo', () => {
  it('misma entrada, misma salida, sin importar el orden de los servicios', () => {
    fc.assert(
      fc.property(servicesArb, originsArb, fc.integer(), (services, origins, seed) => {
        const shuffled = [...services].sort(
          (a, b) => ((Number(a.id) * 31 + seed) % 97) - ((Number(b.id) * 31 + seed) % 97),
        );
        const a = buildOptions(services, origins);
        const b = buildOptions(shuffled, origins);
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        expect(JSON.stringify(buildOptions(services, origins))).toBe(JSON.stringify(a));
      }),
      RUNS,
    );
  });
});

describe('P-U8-11 purga del punto', () => {
  it('tras la purga ningun punto queda en el pedido ni en su resumen', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    u.shipping.services = [
      ...u.shipping.services,
      {
        id: 'pp-1',
        name: 'Punto a punto',
        carrier: 'Correos',
        modality: 'punto',
        destination: 'punto',
        priceCents: 390,
        transitDays: 4,
      },
    ];
    const r = await u.startCheckout.execute(
      checkoutInput(slug, { serviceId: 'pp-1', pointId: 'PT1', expectedTotalCents: 25_390 }),
    );
    expect(r.ok).toBe(true);
    const order = [...u.db.state.orders.values()][0] as Order;
    expect(deliverySummary(order).point?.id).toBe('PT1');
    const purged = purgePersonalData(order, instantOf(Date.now()));
    expect(purged.destination).toBeUndefined();
    expect(deliverySummary(purged).point).toBeUndefined();
    expect(JSON.stringify(purged)).not.toContain('Estanco 1');
  });
});
