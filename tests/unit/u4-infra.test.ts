import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { instantOf } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { ResendEmailSender } from '@/modules/notifications/infrastructure/resend-email-sender';
import {
  PacklinkShipmentAdapter,
  isAllowedLabelUrl,
} from '@/modules/shipping/infrastructure/packlink-shipment-adapter';
import {
  DRAFT_MARK,
  PdfLibInvoiceRenderer,
} from '@/modules/shipping/infrastructure/pdf-invoice-renderer';
import { ResilientHttpClient } from '@/modules/platform/infrastructure/http-client';
import { createResilientFetch } from '@/modules/platform/infrastructure/resilient-fetch';
import { MemoryLogger } from '@tests/support/fakes';
import { FakeClock } from '@tests/support/generators';

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
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4 contenido');

const packlink = (server: ReturnType<typeof fakeServer>, download?: (url: string) => Response) =>
  new PacklinkShipmentAdapter({
    apiKey: 'pk_test_0123456789',
    fetch: createResilientFetch(server.client, 'packlink', 'shipments', {
      timeoutMs: 5_000,
      maxRetries: 1,
    }),
    writeFetch: createResilientFetch(server.client, 'packlink', 'draft', {
      timeoutMs: 15_000,
      maxRetries: 1,
    }),
    ...(download
      ? { downloadFetch: ((u: string) => Promise.resolve(download(u))) as typeof fetch }
      : {}),
    now: () => 1_700_000_000_000,
  });

const draftInput = {
  reference: '11111111-1111-4111-8111-111111111111',
  serviceId: '20001',
  sender: {
    name: 'Ana Art',
    email: 'ana@example.com',
    street: 'Calle Mayor',
    number: '12',
    floorDoor: '',
    postalCode: '28001',
    city: 'Madrid',
    province: 'Madrid',
    phone: '+34612345678',
  },
  recipient: {
    name: 'Lucia Garcia',
    email: 'lucia@example.com',
    phone: '+34612345678',
    street: 'Calle Sol 4',
    complement: '2B',
    postalCode: '08001',
    city: 'Barcelona',
    province: 'Barcelona',
  },
  parcel: { size: 'M' as const, lengthCm: 50, widthCm: 40, heightCm: 10, weightKg: 2 },
  declaredValueCents: 25_000,
  fragile: true,
  modality: 'recogida' as const,
  pickup: { id: '2026-11-10|09:00-13:00', date: '2026-11-10', slot: '09:00-13:00' },
};

describe('PacklinkShipmentAdapter (cliente resiliente)', () => {
  it('crea el borrador con la referencia del pedido, el valor declarado y la recogida elegida', async () => {
    const server = fakeServer(() => json({ reference: 'PL123456' }));
    const r = unwrap(await packlink(server).createDraft(draftInput));
    expect(r.providerRef).toBe('PL123456');
    const call = server.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.packlink.com/v1/shipments');
    expect(call.headers.get('authorization')).toBe('pk_test_0123456789');
    expect(call.headers.get('idempotency-key')).toBe(`shipment:${draftInput.reference}`);
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.shipment_custom_reference).toBe(draftInput.reference);
    expect(body.service_id).toBe('20001');
    expect(body.contentvalue).toBe(250);
    expect(body.collection_date).toBe('2026-11-10');
  });

  it('manda nombre, apellido y correo del remitente y del destinatario, que Packlink exige', async () => {
    const server = fakeServer(() => json({ reference: 'PL123456' }));
    unwrap(
      await packlink(server).createDraft({
        ...draftInput,
        recipient: { ...draftInput.recipient, name: 'Rubén Moya Agustín' },
      }),
    );
    const body = JSON.parse(server.calls[0]!.body) as {
      from: Record<string, string>;
      to: Record<string, string>;
    };
    expect(body.from).toMatchObject({ name: 'Ana', surname: 'Art', email: 'ana@example.com' });
    expect(body.to).toMatchObject({
      name: 'Rubén',
      surname: 'Moya Agustín',
      email: 'lucia@example.com',
    });
    for (const party of [body.from, body.to]) {
      expect(party.name).not.toBe('');
      expect(party.surname).not.toBe('');
      expect(party.email).toContain('@');
    }
  });

  it('un 500 se reintenta con la misma clave; un 4xx se rechaza sin reintento', async () => {
    const flaky = fakeServer((_c, n) => (n === 1 ? json({}, 503) : json({ reference: 'PLX' })));
    expect((await packlink(flaky).createDraft(draftInput)).ok).toBe(true);
    expect(flaky.calls).toHaveLength(2);
    expect(flaky.calls[1]?.headers.get('idempotency-key')).toBe(
      flaky.calls[0]?.headers.get('idempotency-key'),
    );
    const bad = fakeServer(() => json({}, 400));
    const r = await packlink(bad).createDraft(draftInput);
    expect(!r.ok && r.error.code).toBe('validation');
    expect(bad.calls).toHaveLength(1);
  });

  it('busca por referencia propia y devuelve la referencia de Packlink (o nada)', async () => {
    const found = fakeServer(() =>
      json([{ shipment_custom_reference: draftInput.reference, reference: 'PLEXIST' }]),
    );
    expect(unwrap(await packlink(found).findByReference(draftInput.reference))).toEqual({
      providerRef: 'PLEXIST',
    });
    expect(new URL(found.calls[0]!.url).searchParams.get('shipment_custom_reference')).toBe(
      draftInput.reference,
    );
    const none = fakeServer(() => json([]));
    expect(unwrap(await packlink(none).findByReference(draftInput.reference))).toBeUndefined();
    const missing = fakeServer(() => json({}, 404));
    expect(unwrap(await packlink(missing).findByReference(draftInput.reference))).toBeUndefined();
    const down = fakeServer(() => json({}, 503));
    expect((await packlink(down).findByReference(draftInput.reference)).ok).toBe(false);
  });

  it('convierte el estado del envio en hechos hacia delante y los fallos en incidencias', async () => {
    const state = (s: string) =>
      fakeServer(() => json({ state: s, price: 5.2, carrier_tracking_url: 'https://c.test/1' }));
    const types = async (s: string) =>
      unwrap(await packlink(state(s)).fetchFacts('PL1')).map((f) => f.type);
    expect(await types('READY_FOR_COLLECTION')).toEqual(['tracking_info', 'label_ready']);
    expect(await types('IN_TRANSIT')).toEqual(['tracking_info', 'label_ready', 'in_transit']);
    expect(await types('DELIVERED')).toEqual([
      'tracking_info',
      'label_ready',
      'in_transit',
      'delivered',
    ]);
    expect(await types('LABEL_FAILED')).toEqual(['tracking_info', 'label_failed']);
    expect(await types('CARRIER_ERROR')).toEqual(['tracking_info', 'carrier_failed']);
    expect(await types('DRAFT')).toEqual(['tracking_info']);
    const facts = unwrap(await packlink(state('PAID')).fetchFacts('PL1'));
    expect(facts[0]).toMatchObject({ trackingUrl: 'https://c.test/1', labelCostCents: 520 });
  });

  it('descarga la etiqueta solo de Packlink por HTTPS y solo si es un PDF', async () => {
    const labelsOk = fakeServer(() => json(['https://files.packlink.com/etiqueta.pdf']));
    const bytes = unwrap(await packlink(labelsOk, () => new Response(PDF_BYTES)).getLabel('PL1'));
    expect(new TextDecoder().decode(bytes)).toContain('%PDF');

    const evil = fakeServer(() => json(['https://evil.example.com/etiqueta.pdf']));
    expect((await packlink(evil, () => new Response(PDF_BYTES)).getLabel('PL1')).ok).toBe(false);
    const http = fakeServer(() => json(['http://files.packlink.com/e.pdf']));
    expect((await packlink(http, () => new Response(PDF_BYTES)).getLabel('PL1')).ok).toBe(false);
    const notPdf = fakeServer(() => json(['https://files.packlink.com/e.pdf']));
    expect((await packlink(notPdf, () => new Response('<html>no</html>')).getLabel('PL1')).ok).toBe(
      false,
    );
    const big = fakeServer(() => json(['https://files.packlink.com/e.pdf']));
    expect(
      (
        await packlink(
          big,
          () => new Response(new Uint8Array(3 * 1024 * 1024).fill(0x25)),
        ).getLabel('PL1')
      ).ok,
    ).toBe(false);
    expect(isAllowedLabelUrl('https://packlink.com/x')).toBe(true);
    expect(isAllowedLabelUrl('https://packlink.com.evil.com/x')).toBe(false);
    expect(isAllowedLabelUrl('javascript:alert(1)')).toBe(false);
  });

  it('puntos de entrega y fechas de recogida se leen de forma tolerante', async () => {
    const dropoffs = fakeServer(() =>
      json([
        { commerce_name: 'Kiosco', address: 'Calle A 1', opening_times: 'L-V 9-14', distance: 0.4 },
        { name: 'Sin direccion' },
        7,
      ]),
    );
    const points = unwrap(await packlink(dropoffs).getDropoffs('20001', '28001'));
    expect(points).toEqual([
      { name: 'Kiosco', address: 'Calle A 1', schedule: 'L-V 9-14', distanceKm: 0.4 },
    ]);
    expect(dropoffs.calls[0]?.url).toContain('/v1/dropoffs/20001/ES/28001');

    const byDate = fakeServer(() =>
      json({ '2026-11-10': ['09:00-13:00', '15:00-19:00'], basura: 'x' }),
    );
    const opts = unwrap(await packlink(byDate).getPickupOptions('20001', '28001'));
    expect(opts.map((o) => o.id)).toEqual(['2026-11-10|09:00-13:00', '2026-11-10|15:00-19:00']);
    const asList = fakeServer(() => json([{ date: '2026-11-11', slots: ['09:00-13:00'] }]));
    expect(unwrap(await packlink(asList).getPickupOptions('20001', '28001'))).toHaveLength(1);
  });
});

describe('ResendEmailSender', () => {
  const sender = (server: ReturnType<typeof fakeServer>, sandboxRedirect?: string) =>
    new ResendEmailSender({
      apiKey: 're_test_0123456789',
      from: 'avisos@example.com',
      sandboxRedirect,
      fetch: createResilientFetch(server.client, 'resend', 'emails', { timeoutMs: 10_000 }),
    });
  const message = {
    to: 'lucia@example.com',
    subject: 'Hola',
    text: 'Cuerpo',
    idempotencyKey: 'notif:1',
  };

  it('envia texto plano con la clave de idempotencia y sin rastreo', async () => {
    const server = fakeServer(() => json({ id: 'em_1' }));
    expect((await sender(server).send(message)).ok).toBe(true);
    const call = server.calls[0]!;
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.headers.get('authorization')).toBe('Bearer re_test_0123456789');
    expect(call.headers.get('idempotency-key')).toBe('notif:1');
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body).toEqual({
      from: 'avisos@example.com',
      to: ['lucia@example.com'],
      subject: 'Hola',
      text: 'Cuerpo',
    });
    expect(body).not.toHaveProperty('html');
    expect(body).not.toHaveProperty('tags');
  });

  it('fuera de produccion redirige todo a la direccion de pruebas con asunto [PRUEBA]', async () => {
    const server = fakeServer(() => json({ id: 'em_1' }));
    await sender(server, 'pruebas@example.com').send(message);
    const body = JSON.parse(server.calls[0]!.body) as { to: string[]; subject: string };
    expect(body.to).toEqual(['pruebas@example.com']);
    expect(body.subject).toBe('[PRUEBA] Hola');
    expect(server.calls[0]!.body).not.toContain('lucia@example.com');
  });

  it('clasifica los errores: 5xx y 429 reintentables, 4xx permanentes', async () => {
    const code = async (status: number) => {
      const r = await sender(fakeServer(() => json({}, status))).send(message);
      return r.ok ? 'ok' : r.error.code;
    };
    expect(await code(500)).toBe('dependency_unavailable');
    expect(await code(429)).toBe('dependency_unavailable'); // el cliente resiliente lo agota como fallo del proveedor
    expect(await code(422)).toBe('validation');
    expect(await code(401)).toBe('validation');
    expect(await code(200)).toBe('ok');
  });
});

describe('PdfLibInvoiceRenderer (PDF real)', () => {
  it('genera un PDF de una pagina con la marca de borrador y sin NIF inventado', async () => {
    const bytes = await new PdfLibInvoiceRenderer().render({
      orderRef: 'abc12345',
      issuedAt: instantOf(Date.UTC(2026, 10, 6, 10, 0)),
      artistName: 'Ana Art',
      artistEmail: 'ana@example.com',
      artistAddress: 'Calle Mayor 12, 28001 Madrid',
      platformName: 'MarketLink',
      title: 'Oleo sobre lienzo',
      workCents: 25_000,
      shippingCents: 450,
      totalCents: 25_450,
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toContain('Borrador');

    // El texto de la pagina (marca, NIF pendiente, importes) esta en un flujo comprimido.
    const raw = Buffer.from(bytes);
    const text: string[] = [];
    let from = 0;
    for (;;) {
      const s = raw.indexOf('stream', from);
      if (s < 0) break;
      const start = raw[s + 6] === 0x0d ? s + 8 : s + 7;
      const end = raw.indexOf('endstream', start);
      if (end < 0) break;
      try {
        text.push(inflateSync(raw.subarray(start, end)).toString('latin1'));
      } catch {
        text.push(raw.subarray(start, end).toString('latin1'));
      }
      from = end + 9;
    }
    const all = text.join('\n');
    const hex = (t: string) => Buffer.from(t, 'latin1').toString('hex').toUpperCase();
    expect(all.toUpperCase()).toContain(hex('BORRADOR'));
    expect(all.toUpperCase()).toContain(hex('NIF: pendiente de completar').toUpperCase());
    expect(DRAFT_MARK).toContain('BORRADOR');
  });
});
