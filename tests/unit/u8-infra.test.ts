import { describe, expect, it, vi } from 'vitest';
import { unwrap } from '@/modules/kernel/domain/result';
import {
  PacklinkShippingAdapter,
  parsePoint,
  parseService,
} from '@/modules/checkout/infrastructure/packlink-shipping-adapter';
import { PacklinkShipmentAdapter } from '@/modules/shipping/infrastructure/packlink-shipment-adapter';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stubFetch = (respond: (url: string, init: RequestInit | undefined) => Response) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(respond(String(input), init));
  });
  return { fetch: fn as unknown as typeof fetch, calls };
};

const svc = (over: Record<string, unknown> = {}) => ({
  id: 20001,
  carrier_name: 'Correos',
  name: 'Paq Estandar',
  dropoff: true,
  delivery_to_parcelshop: false,
  transit_hours: '48',
  price: { total_price: 4.5 },
  ...over,
});

describe('U8 servicios de Packlink con origen y destino (ADR 0031)', () => {
  it('el origen sale de `dropoff` y el destino de `delivery_to_parcelshop`', () => {
    expect(parseService(svc())).toMatchObject({
      modality: 'punto',
      destination: 'domicilio',
      carrier: 'Correos',
    });
    expect(parseService(svc({ dropoff: false, delivery_to_parcelshop: true }))).toMatchObject({
      modality: 'recogida',
      destination: 'punto',
    });
    expect(parseService(svc({ dropoff: true, delivery_to_parcelshop: true }))).toMatchObject({
      modality: 'punto',
      destination: 'punto',
    });
  });

  it('descarta un servicio sin transportista', () => {
    expect(parseService(svc({ carrier_name: undefined }))).toBeUndefined();
  });
});

describe('U8 puntos de recogida de destino', () => {
  const point = (over: Record<string, unknown> = {}) => ({
    id: 'ES-123',
    commerce_name: 'Estanco Centro',
    address: 'Calle Mayor 1',
    zip: '08001',
    city: 'Barcelona',
    opening_times: 'L-V 9-20',
    ...over,
  });

  it('reduce un punto con textos acotados y sin interpretar HTML', () => {
    const p = parsePoint(point({ commerce_name: 'x'.repeat(500) }));
    expect(p?.name).toHaveLength(120);
    expect(p?.address).toBe('Calle Mayor 1, 08001, Barcelona');
    expect(parsePoint(point({ id: 'a b<script>' }))).toBeUndefined();
    expect(parsePoint(point({ commerce_name: undefined }))).toBeUndefined();
    expect(parsePoint(null)).toBeUndefined();
  });

  it('pide los puntos del servicio y el codigo postal de la compradora y descarta los invalidos', async () => {
    const stub = stubFetch(() => json([point(), point({ id: '' }), 7]));
    const adapter = new PacklinkShippingAdapter({
      apiKey: 'pk_test_0123456789',
      fetch: stub.fetch,
    });
    const points = unwrap(await adapter.getDeliveryPoints('20001', '08001'));
    expect(points).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe('https://api.packlink.com/v1/dropoffs/20001/ES/08001');
  });

  it('un error del proveedor o un cuerpo que no es una lista es proveedor caido', async () => {
    const down = new PacklinkShippingAdapter({
      apiKey: 'k',
      fetch: stubFetch(() => json({}, 503)).fetch,
    });
    const r1 = await down.getDeliveryPoints('1', '08001');
    expect(!r1.ok && r1.error.code).toBe('dependency_unavailable');
    const bad = new PacklinkShippingAdapter({
      apiKey: 'k',
      fetch: stubFetch(() => json({ error: 'x' })).fetch,
    });
    const r2 = await bad.getDeliveryPoints('1', '08001');
    expect(!r2.ok && r2.error.code).toBe('dependency_unavailable');
  });
});

describe('U8 borrador con punto de recogida (ADR 0031)', () => {
  const draft = (pointId: string | undefined) => ({
    reference: 'ord-1',
    serviceId: '20001',
    sender: {
      name: 'Ana Art',
      email: 'ana@example.com',
      street: 'Calle Sol',
      number: '1',
      floorDoor: '',
      postalCode: '28001',
      city: 'Madrid',
      province: 'Madrid',
      phone: '600000001',
    },
    recipient: {
      name: 'Lucia Mora',
      email: 'lucia@example.com',
      phone: '600000002',
      street: 'Calle Mar 2',
      complement: '',
      postalCode: '08001',
      city: 'Barcelona',
      province: 'Barcelona',
      pointId,
    },
    parcel: { size: 'M' as const, lengthCm: 50, widthCm: 40, heightCm: 10, weightKg: 2 },
    declaredValueCents: 25_000,
    fragile: false,
    modality: 'punto' as const,
    pickup: undefined,
  });

  it('manda `dropoff_point_id` en la raiz del cuerpo solo si hay punto', async () => {
    const stub = stubFetch(() => json({ reference: 'PL1' }));
    const adapter = new PacklinkShipmentAdapter({
      apiKey: 'k',
      fetch: stub.fetch,
      writeFetch: stub.fetch,
    });
    unwrap(await adapter.createDraft(draft('ES-123')));
    expect(JSON.parse(String(stub.calls[0]?.init?.body))).toMatchObject({
      dropoff_point_id: 'ES-123',
    });
    unwrap(await adapter.createDraft(draft(undefined)));
    expect(JSON.parse(String(stub.calls[1]?.init?.body))).not.toHaveProperty('dropoff_point_id');
  });
});
