import { describe, expect, it } from 'vitest';
import { MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { healthStatus } from '@/modules/operator/domain/health';
import { buildU3, sellableListing } from '@tests/support/u3-harness';

const BOTH = { origins: ['punto', 'recogida'] };

const quote = async (u: ReturnType<typeof buildU3>, slug: string, ip = '1.1.1.1', cp = '08001') =>
  u.quote.execute(slug, cp, ip, 'c');

describe('U8 cache de proveedor (EN-17)', () => {
  it('la segunda consulta sale de la cache y la caducada se vuelve a pedir', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    unwrap(await quote(u, slug));
    unwrap(await quote(u, slug));
    expect(u.shipping.calls).toBe(1);
    u.clock.advance(11 * MS.minute);
    unwrap(await quote(u, slug));
    expect(u.shipping.calls).toBe(2);
  });

  it('con la cache vencida y Packlink caido nunca se usa el dato caducado (NFR-U8-16)', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    unwrap(await quote(u, slug));
    u.clock.advance(11 * MS.minute);
    u.shipping.fail = true;
    const r = await quote(u, slug);
    expect(!r.ok && r.error.code).toBe('dependency_unavailable');
  });

  it('un fallo de la cache no impide operar (NFR-U8-17)', async () => {
    const u = buildU3();
    u.cache.failReads = true;
    u.cache.failWrites = true;
    const { slug } = await sellableListing(u);
    const r = unwrap(await quote(u, slug));
    expect(r.kind).toBe('opciones');
    expect(u.shipping.calls).toBe(1);
  });

  it('la cache no guarda datos personales (NFR-U8-27)', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u);
    unwrap(await quote(u, slug));
    const dump = JSON.stringify([...u.cache.entries.entries()]);
    expect(dump).not.toMatch(/@|lucia|Calle/i);
    expect([...u.cache.entries.keys()].every((k) => !k.includes('@'))).toBe(true);
  });
});

describe('U8 opciones segun los origenes de la artista (US-053, US-056)', () => {
  it('con solo recogida se ofrecen solo los servicios de recogida', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u, { origins: ['recogida'] });
    const r = unwrap(await quote(u, slug));
    if (r.kind !== 'opciones') throw new Error('esperaba opciones');
    expect(r.options.groups.domicilio.map((s) => s.id)).toEqual(['r-1']);
    expect(r.options.preselected?.id).toBe('r-1');
  });

  it('con los dos origenes se ofrecen todos y se preselecciona la mas barata a domicilio', async () => {
    const u = buildU3();
    const { slug } = await sellableListing(u, BOTH);
    const r = unwrap(await quote(u, slug));
    if (r.kind !== 'opciones') throw new Error('esperaba opciones');
    expect(r.options.groups.domicilio.map((s) => s.id)).toEqual(['p-b', 'p-a', 'r-1']);
    expect(r.options.preselected?.id).toBe('p-b');
  });

  it('con servicios de punto y de domicilio los agrupa por destino', async () => {
    const u = buildU3();
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
    const { slug } = await sellableListing(u);
    const r = unwrap(await quote(u, slug));
    if (r.kind !== 'opciones') throw new Error('esperaba opciones');
    expect(r.options.groups.punto.map((s) => s.id)).toEqual(['pp-1']);
    expect(r.options.preselected?.destination).toBe('domicilio');
  });
});

describe('U8 puntos de recogida (US-060)', () => {
  const withPointService = (u: ReturnType<typeof buildU3>) => {
    u.shipping.services = [
      ...u.shipping.services,
      {
        id: '555',
        name: 'Punto a punto',
        carrier: 'Correos',
        modality: 'punto',
        destination: 'punto',
        priceCents: 390,
        transitDays: 4,
      },
    ];
  };

  it('devuelve los puntos de un servicio con destino punto y los guarda en cache', async () => {
    const u = buildU3();
    withPointService(u);
    const { slug } = await sellableListing(u);
    const a = unwrap(await u.listPoints.execute(slug, '08001', '555', '1.1.1.1', 'c'));
    expect(a.map((p) => p.id)).toEqual(['PT1', 'PT2']);
    unwrap(await u.listPoints.execute(slug, '08001', '555', '1.1.1.1', 'c'));
    expect(u.shipping.pointCalls).toBe(1);
  });

  it('rechaza un servicio a domicilio, uno inexistente y un identificador malformado', async () => {
    const u = buildU3();
    withPointService(u);
    const { slug } = await sellableListing(u);
    for (const id of ['p-b', '999', "1'; DROP", '']) {
      const r = await u.listPoints.execute(slug, '08001', id, '1.1.1.1', 'c');
      expect(!r.ok && r.error.code).toBe('validation');
    }
    expect(u.shipping.pointCalls).toBe(0);
  });

  it('Packlink caido: error de dependencia, no se inventa una lista', async () => {
    const u = buildU3();
    withPointService(u);
    u.shipping.pointsFail = true;
    const { slug } = await sellableListing(u);
    const r = await u.listPoints.execute(slug, '08001', '555', '1.1.1.1', 'c');
    expect(!r.ok && r.error.code).toBe('dependency_unavailable');
  });

  it('limita las consultas de puntos por IP (60 cada 10 minutos, NFR-U8-21)', async () => {
    const u = buildU3();
    withPointService(u);
    const { slug } = await sellableListing(u);
    let last = await u.listPoints.execute(slug, '08001', '555', '9.9.9.9', 'c');
    for (let i = 0; i < 65; i++)
      last = await u.listPoints.execute(slug, '08001', '555', '9.9.9.9', 'c');
    expect(!last.ok && last.error.code).toBe('rate_limited');
  });
});

describe('U8 origenes del enlace (US-053, US-055)', () => {
  it('un enlace sin ningun origen se rechaza', async () => {
    const u = buildU3();
    const artistId = await u.readyArtist();
    const r = await u.createListing(artistId, { origins: [] });
    expect(!r.ok && r.error.code).toBe('validation');
  });

  it('se guardan uno o dos origenes y la modalidad antigua se deriva', async () => {
    const u = buildU3();
    const { artistId, listing } = await sellableListing(u, BOTH);
    expect(listing.origins).toEqual(['punto', 'recogida']);
    expect(listing.modality).toBe('punto');
    const only = unwrap(
      await u.listings.updateListing(artistId, listing.id, { origins: ['recogida'] }),
    );
    expect(only.origins).toEqual(['recogida']);
    expect(only.modality).toBe('recogida');
    const bad = await u.listings.updateListing(artistId, listing.id, { origins: [] });
    expect(!bad.ok && bad.error.code).toBe('validation');
  });

  it('un enlace con solo `modality` (formato anterior) sigue funcionando', async () => {
    const u = buildU3();
    const { listing } = await sellableListing(u, { modality: 'recogida', origins: undefined });
    expect(listing.origins).toEqual(['recogida']);
  });
});

describe('U8 borradores sin pagar en la salud (US-068, US-069)', () => {
  const base = {
    dbOk: true,
    failedJobs24h: 0,
    oldestPendingJobMinutes: undefined,
    failedEmails: 0,
    backupAgeHours: undefined,
    openCircuits: 0,
    quotasStale: false,
    live: false,
  };

  it('pasa a atencion cuando el borrador mas antiguo supera el umbral', () => {
    expect(
      healthStatus({ ...base, oldestUnpaidDraftHours: 23, unpaidDraftAlertHours: 24 }).state,
    ).toBe('verde');
    const over = healthStatus({ ...base, oldestUnpaidDraftHours: 24, unpaidDraftAlertHours: 24 });
    expect(over.state).toBe('ambar');
    expect(over.reasons.join(' ')).toContain('borrador');
  });

  it('sin datos no cambia el estado', () => {
    expect(healthStatus(base).state).toBe('verde');
  });
});
