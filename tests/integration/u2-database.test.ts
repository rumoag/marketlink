import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { instantOf, MS } from '@/modules/kernel/domain/clock';
import { Email } from '@/modules/kernel/domain/formats';
import { unwrap } from '@/modules/kernel/domain/result';
import { ListingService } from '@/modules/listings/application/listing-service';
import { PhotoService } from '@/modules/listings/application/photo-service';
import { ReservationService } from '@/modules/listings/application/reservation-service';
import { SlugTakenError } from '@/modules/listings/application/ports';
import type { Slug } from '@/modules/listings/domain/slug';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { RateLimiter } from '@/modules/platform/application/rate-limiter';
import { artistScope, systemScope } from '@/modules/platform/application/unit-of-work';
import { createDb, type Db } from '@/modules/platform/infrastructure/db-client';
import { PgTransactionRunner } from '@/modules/platform/infrastructure/pg-runner';
import { PgAuditStore, PgCounterStore } from '@/modules/platform/infrastructure/pg-stores';
import { ApplyAccountEventUseCase } from '@/services/apply-account-event';
import { createAppRepos } from '@/services/pg-repos';
import { PgWebhookEventStore } from '@/services/pg-webhook-store';
import type { AppRepos } from '@/services/repos';
import { FakeClock } from '@tests/support/generators';
import { MemoryLogger } from '@tests/support/fakes';
import { SeqIds, SeqRandom, StubProcessor, StubStorage } from '@tests/support/stubs';
import { connectTestDb, describeDb, resetDatabase, testDatabaseUrl } from './helpers';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const APP_PASSWORD = 'apppass-integration';

const draft = {
  title: 'Obra de prueba',
  description: '',
  priceCents: 25000,
  declaredValueCents: 25000,
  fragile: false,
  size: 'M',
  modality: 'punto',
} as const;

const enabled = (eventAt: number) => ({
  detailsSubmitted: true,
  transfersActive: true,
  payoutsEnabled: true,
  disabled: false,
  eventAt,
});

describeDb('U2: base de datos con el rol de la aplicacion (RLS)', () => {
  let admin: Db; // propietario: prepara el esquema y comprueba resultados
  let app: Db; // marketlink_app: lo que usa la aplicacion, con RLS
  let runner: PgTransactionRunner<AppRepos>;
  const clock = new FakeClock(Date.UTC(2026, 10, 5, 12, 0, 0));

  beforeAll(async () => {
    admin = connectTestDb();
    await resetDatabase(admin);
    await admin.query(`ALTER ROLE marketlink_app LOGIN PASSWORD '${APP_PASSWORD}'`);
    const url = new URL(testDatabaseUrl as string);
    url.username = 'marketlink_app';
    url.password = APP_PASSWORD;
    app = createDb(url.toString(), { max: 12 });
    runner = new PgTransactionRunner<AppRepos>(app, createAppRepos({ clock, ids: new SeqIds() }));
  });

  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query(
      'TRUNCATE reservations, listing_photos, photo_uploads, listings, payout_accounts, sender_addresses, artists, jobs, webhook_events, rate_limit_counters CASCADE',
    );
  });

  const seedArtists = async () => {
    for (const [id, mail] of [
      [A, 'ana@example.com'],
      [B, 'berta@example.com'],
    ] as const) {
      await runner.run(systemScope, (r) =>
        r.artists.upsertOnSignIn(id, unwrap(Email.parse(mail)), instantOf(clock.now())),
      );
    }
  };

  const insertListing = (artistId: string, slug: string, id: string) =>
    runner.run(artistScope(artistId), (r) =>
      r.listings.insert(artistId, id, slug as Slug, draft, instantOf(clock.now())),
    );

  const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  // ---------------------------------------------------------------------------------------
  it('el rol de la aplicacion no ve ninguna fila sin contexto (denegar por defecto)', async () => {
    await seedArtists();
    await insertListing(A, 'abcdefgh', ID(1));
    for (const table of [
      'artists',
      'listings',
      'payout_accounts',
      'sender_addresses',
      'photo_uploads',
    ]) {
      const res = await app.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      expect(res.rows[0]?.n, table).toBe('0');
    }
  });

  it('EN-03: un artista no ve ni modifica los datos de otro (dos artistas)', async () => {
    await seedArtists();
    const listing = await insertListing(A, 'abcdefgh', ID(1));

    // B no lo ve por ningun camino de lectura.
    expect(
      await runner.run(artistScope(B), (r) => r.listings.findById(listing.id)),
    ).toBeUndefined();
    expect(
      await runner.run(artistScope(B), (r) => r.listings.findBySlug(listing.slug)),
    ).toBeUndefined();
    expect(await runner.run(artistScope(B), (r) => r.listings.listByArtist(A))).toEqual([]);
    expect(await runner.run(artistScope(B), (r) => r.artists.findById(A))).toBeUndefined();

    // B no puede escribir sobre lo de A: la sentencia no encuentra filas.
    await runner.run(artistScope(B), (r) => r.listings.save({ ...listing, title: 'Pirateado' }));
    const stored = await admin.query<{ title: string }>(
      'SELECT title FROM listings WHERE id = $1',
      [listing.id],
    );
    expect(stored.rows[0]?.title).toBe('Obra de prueba');

    // B no puede crear filas a nombre de A (WITH CHECK).
    await expect(
      runner.run(artistScope(B), (r) =>
        r.listings.insert(A, ID(2), 'zzzzzzzz' as Slug, draft, instantOf(clock.now())),
      ),
    ).rejects.toThrow(/row-level security/i);

    // Ni siquiera con SQL directo dentro de su contexto.
    const direct = await runner.run(artistScope(B), async () => {
      const res = await app.query('SELECT 1');
      return res.rowCount;
    });
    expect(direct).toBe(1); // la conexion funciona; lo importante es lo anterior
  });

  it('la direccion, los cobros y las subidas de un artista son invisibles para otro', async () => {
    await seedArtists();
    await runner.run(artistScope(A), async (r) => {
      await r.addresses.save(
        A,
        {
          street: 'Calle Mayor',
          number: '1',
          floorDoor: '',
          postalCode: '28001' as never,
          city: 'Madrid',
          province: 'Madrid',
          phone: '+34612345678' as never,
        },
        instantOf(clock.now()),
      );
      await r.payouts.lockForUpdate(A);
    });
    expect(await runner.run(artistScope(B), (r) => r.addresses.find(A))).toBeUndefined();
    expect(await runner.run(artistScope(B), (r) => r.payouts.find(A))).toBeUndefined();
    expect(await runner.run(artistScope(A), (r) => r.addresses.find(A))).toBeDefined();
  });

  it('el rol de la aplicacion no puede borrar enlaces ni accede a nada desde anon o authenticated', async () => {
    await seedArtists();
    await insertListing(A, 'abcdefgh', ID(1));
    await expect(runner.run(systemScope, () => app.query('DELETE FROM listings'))).rejects.toThrow(
      /permission denied/i,
    );
    for (const role of ['anon', 'authenticated']) {
      for (const table of [
        'artists',
        'sender_addresses',
        'payout_accounts',
        'listings',
        'listing_photos',
        'photo_uploads',
        'reservations',
        'size_presets',
      ]) {
        await expect(
          admin.transaction(async (client) => {
            await client.query(`SET LOCAL ROLE ${role}`);
            return client.query(`SELECT 1 FROM ${table} LIMIT 1`);
          }),
          `${role} ${table}`,
        ).rejects.toThrow(/permission denied/i);
      }
    }
  });

  it('los tamanos S, M y L estan sembrados y son legibles por la aplicacion', async () => {
    const sizes = await runner.run(artistScope(A), (r) => r.sizes.list());
    expect(sizes.map((s) => [s.size, s.lengthCm, s.widthCm, s.heightCm, s.weightKg])).toEqual([
      ['S', 30, 25, 5, 1],
      ['M', 50, 40, 10, 2],
      ['L', 80, 60, 10, 5],
    ]);
  });

  // ---------------------------------------------------------------------------------------
  it('slug unico: una colision lanza SlugTakenError (y la transaccion se deshace)', async () => {
    await seedArtists();
    await insertListing(A, 'abcdefgh', ID(1));
    await expect(insertListing(B, 'abcdefgh', ID(2))).rejects.toBeInstanceOf(SlugTakenError);
    const n = await admin.query<{ n: string }>('SELECT count(*)::text AS n FROM listings');
    expect(n.rows[0]?.n).toBe('1');
  });

  it('las restricciones de la base rechazan estados incoherentes', async () => {
    await seedArtists();
    const base = `INSERT INTO listings (artist_id, slug, title, price_cents, declared_value_cents, size, modality`;
    await expect(
      admin.query(
        `${base}, status) VALUES ($1, 'bbbbbbbb', 'Titulo', 1000, 1000, 'M', 'punto', 'pausado')`,
        [A],
      ),
    ).rejects.toThrow(/check constraint/i); // pausado exige motivo
    await expect(
      admin.query(`${base}) VALUES ($1, 'cccccccc', 'Titulo', 99, 99, 'M', 'punto')`, [A]),
    ).rejects.toThrow(/check constraint/i); // menos de 1,00 EUR
    await expect(
      admin.query(`${base}) VALUES ($1, 'iiiiiiii', 'Titulo', 1000, 1000, 'M', 'punto')`, [A]),
    ).rejects.toThrow(/check constraint/i); // la i no pertenece al alfabeto del slug
    await expect(
      admin.query(
        `INSERT INTO sender_addresses (artist_id, street, number, postal_code, city, province, phone)
                   VALUES ($1, 'Calle', '1', '35001', 'Las Palmas', 'Las Palmas', '+34612345678')`,
        [A],
      ),
    ).rejects.toThrow(/check constraint/i); // Canarias no se admite
  });

  it('las posiciones de fotos son unicas por enlace pero se pueden compactar dentro de una transaccion', async () => {
    await seedArtists();
    await insertListing(A, 'abcdefgh', ID(1));
    const photo = (n: number, position: number) => ({
      id: ID(100 + n),
      listingId: ID(1),
      artistId: A,
      position,
      storageKeyFull: `a/${n}-1600.webp`,
      storageKeyThumb: `a/${n}-480.webp`,
      width: 100,
      height: 100,
      bytes: 10,
    });
    await runner.run(artistScope(A), (r) =>
      r.photos.insertMany([photo(1, 1), photo(2, 2), photo(3, 3)], instantOf(clock.now())),
    );
    // Duplicar una posicion falla al confirmar.
    await expect(
      runner.run(artistScope(A), (r) =>
        r.photos.insertMany([{ ...photo(4, 3) }], instantOf(clock.now())),
      ),
    ).rejects.toThrow();
    // Quitar la primera y renumerar funciona gracias a la restriccion diferible.
    await runner.run(artistScope(A), async (r) => {
      await r.photos.remove(ID(101));
      await r.photos.renumber(ID(1), [ID(102), ID(103)]);
    });
    const left = await runner.run(artistScope(A), (r) => r.photos.listByListing(ID(1)));
    expect(left.map((p) => [p.id, p.position])).toEqual([
      [ID(102), 1],
      [ID(103), 2],
    ]);
  });

  // ---------------------------------------------------------------------------------------
  it('R-04/BR2-RS2: 10 reservas simultaneas del mismo enlace: solo una gana', async () => {
    await seedArtists();
    await insertListing(A, 'abcdefgh', ID(1));
    const service = new ReservationService({ runner, ids: new SeqIds(), clock });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.reserve(ID(1), 10 * MS.minute)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(9);

    // La segunda barrera: el indice unico parcial rechaza una segunda reserva activa.
    await expect(
      admin.query(
        `INSERT INTO reservations (listing_id, artist_id, status, expires_at) VALUES ($1, $2, 'activa', now() + interval '1 hour')`,
        [ID(1), A],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('una reserva vencida libera el enlace y markSold la consume y vende de forma irreversible', async () => {
    await seedArtists();
    await insertListing(A, 'abcdefgh', ID(1));
    const service = new ReservationService({ runner, ids: new SeqIds(), clock });
    unwrap(await service.reserve(ID(1), 5 * MS.minute));
    expect((await service.reserve(ID(1), 5 * MS.minute)).ok).toBe(false);
    clock.advance(6 * MS.minute);
    unwrap(await service.reserve(ID(1), 5 * MS.minute)); // la anterior venció

    unwrap(await service.markSold(ID(1), ID(900)));
    const row = await admin.query<{ status: string; order_id: string }>(
      'SELECT status, order_id FROM listings WHERE id = $1',
      [ID(1)],
    );
    expect(row.rows[0]).toEqual({ status: 'vendido', order_id: ID(900) });
    expect((await service.reserve(ID(1), 5 * MS.minute)).ok).toBe(false);
    expect((await service.markSold(ID(1), undefined)).ok).toBe(false);
    const active = await admin.query("SELECT 1 FROM reservations WHERE status = 'activa'");
    expect(active.rowCount).toBe(0);
  });

  // ---------------------------------------------------------------------------------------
  const buildServices = (maxOpenListings: number) => {
    const logger = new MemoryLogger();
    const storage = new StubStorage();
    const ids = new SeqIds();
    const limiter = new RateLimiter({
      store: new PgCounterStore(app),
      hasher: (_r, s) => s,
      clock,
      audit: new AuditLog(new PgAuditStore(app), logger, clock),
      logger,
    });
    const photos = new PhotoService({
      runner,
      storage,
      processor: new StubProcessor(),
      limiter,
      ids,
      clock,
      logger,
    });
    const listings = new ListingService({
      runner,
      storage,
      limiter,
      audit: new AuditLog(new PgAuditStore(app), logger, clock),
      random: new SeqRandom(undefined, 777),
      ids,
      clock,
      logger,
      appUrl: 'https://app.test',
      maxOpenListings,
    });
    return { photos, listings, storage };
  };

  const readyArtistInDb = async (id: string, mail: string) => {
    await runner.run(systemScope, async (r) => {
      await r.artists.upsertOnSignIn(id, unwrap(Email.parse(mail)), instantOf(clock.now()));
      await r.artists.saveProfile(
        id,
        { artisticName: 'Ana Art', instagram: 'ana' as never, phone: '+34612345678' as never },
        instantOf(clock.now()),
      );
      await r.addresses.save(
        id,
        {
          street: 'Calle Mayor',
          number: '1',
          floorDoor: '',
          postalCode: '28001' as never,
          city: 'Madrid',
          province: 'Madrid',
          phone: '+34612345678' as never,
        },
        instantOf(clock.now()),
      );
    });
    const apply = new ApplyAccountEventUseCase({ runner, clock, logger: new MemoryLogger() });
    unwrap(await apply.applySnapshot(id, enabled(clock.now()), 'c'));
  };

  const jpeg = () => {
    const b = new Uint8Array(64);
    b.set([0xff, 0xd8, 0xff, 0xe0]);
    return b;
  };

  it('P-U2-15: 8 altas simultaneas del mismo artista con limite 3: exactamente 3 se crean', async () => {
    await readyArtistInDb(A, 'ana@example.com');
    const { photos, listings } = buildServices(3);
    const uploads: string[] = [];
    for (let i = 0; i < 8; i++) uploads.push(unwrap(await photos.upload(A, jpeg(), 'c')).uploadId);

    const input = { title: 'Obra', price: '25', size: 'M', modality: 'punto' };
    const results = await Promise.all(
      uploads.map((u) => listings.createListing(A, input, [u], 'c')),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const open = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM listings WHERE status <> 'vendido'",
    );
    expect(open.rows[0]?.n).toBe('3');
    // Los slugs de las altas simultaneas son todos distintos.
    const slugs = await admin.query<{ slug: string }>('SELECT slug FROM listings');
    expect(new Set(slugs.rows.map((r) => r.slug)).size).toBe(3);
  });

  it('artistas distintos crean a la vez sin bloquearse y cada uno ve solo lo suyo', async () => {
    await readyArtistInDb(A, 'ana@example.com');
    await readyArtistInDb(B, 'berta@example.com');
    const { photos, listings } = buildServices(3);
    const ua = unwrap(await photos.upload(A, jpeg(), 'c')).uploadId;
    const ub = unwrap(await photos.upload(B, jpeg(), 'c')).uploadId;
    const input = { title: 'Obra', price: '25', size: 'M', modality: 'punto' };
    const [ra, rb] = await Promise.all([
      listings.createListing(A, input, [ua], 'c'),
      listings.createListing(B, input, [ub], 'c'),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(unwrap(await listings.listMine(A))).toHaveLength(1);
    expect(unwrap(await listings.listMine(B))).toHaveLength(1);
  });

  it('una subida solo la puede consumir su artista y se consume una vez (dos altas simultaneas con la misma)', async () => {
    await readyArtistInDb(A, 'ana@example.com');
    await readyArtistInDb(B, 'berta@example.com');
    const { photos, listings } = buildServices(5);
    const upload = unwrap(await photos.upload(A, jpeg(), 'c')).uploadId;
    const input = { title: 'Obra', price: '25', size: 'M', modality: 'punto' };

    const stolen = await listings.createListing(B, input, [upload], 'c');
    expect(!stolen.ok && stolen.error.code).toBe('validation');

    const results = await Promise.all([
      listings.createListing(A, input, [upload], 'c'),
      listings.createListing(A, input, [upload], 'c'),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const used = await admin.query('SELECT status FROM photo_uploads WHERE id = $1', [upload]);
    expect(used.rows[0]).toEqual({ status: 'consumida' });
  });

  it('la limpieza borra solo las subidas pendientes caducadas', async () => {
    await readyArtistInDb(A, 'ana@example.com');
    const { photos, storage } = buildServices(5);
    unwrap(await photos.upload(A, jpeg(), 'c'));
    expect(unwrap(await photos.cleanupExpiredUploads()).removed).toBe(0);
    clock.advance(25 * MS.hour);
    expect(unwrap(await photos.cleanupExpiredUploads()).removed).toBe(1);
    expect(storage.objects.size).toBe(0);
    const left = await admin.query('SELECT 1 FROM photo_uploads');
    expect(left.rowCount).toBe(0);
  });

  // ---------------------------------------------------------------------------------------
  it('R-08/P-U2-12: la restriccion pausa los enlaces activos una sola vez aunque lleguen 5 eventos iguales a la vez', async () => {
    await readyArtistInDb(A, 'ana@example.com');
    await runner.run(systemScope, (r) =>
      r.payouts.setProviderAccount(A, 'acct_X', instantOf(clock.now())),
    );
    for (let i = 0; i < 3; i++) await insertListing(A, `abcdefg${'23456'[i]}`, ID(10 + i));
    await insertListing(A, 'abcdefg7', ID(20));
    await runner.run(systemScope, async (r) => {
      const sold = await r.listings.findById(ID(20));
      if (sold) await r.listings.save({ ...sold, status: 'vendido', soldAt: instantOf(1) });
    });

    const apply = new ApplyAccountEventUseCase({ runner, clock, logger: new MemoryLogger() });
    const restricted = { ...enabled(clock.now() + 1000), disabled: true };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => apply.applyByProviderAccount('acct_X', restricted)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const became = results.filter((r) => r.ok && r.value?.becameRestricted);
    expect(became).toHaveLength(1);

    const rows = await admin.query<{ status: string; paused_reason: string | null }>(
      'SELECT status, paused_reason FROM listings ORDER BY slug',
    );
    expect(
      rows.rows.filter((r) => r.status === 'pausado' && r.paused_reason === 'cobros_restringidos'),
    ).toHaveLength(3);
    expect(rows.rows.filter((r) => r.status === 'vendido')).toHaveLength(1);
    expect(rows.rows.some((r) => r.status === 'activo')).toBe(false);

    // Un evento mas antiguo no cambia nada y recuperar la cuenta no reactiva los enlaces.
    const stale = await apply.applyByProviderAccount('acct_X', enabled(clock.now()));
    expect(stale.ok && stale.value?.applied).toBe(false);
    unwrap(await apply.applyByProviderAccount('acct_X', enabled(clock.now() + 5000)));
    const after = await admin.query(
      "SELECT count(*)::text AS n FROM listings WHERE status = 'activo'",
    );
    expect(after.rows[0]?.n).toBe('0');
    const state = await admin.query('SELECT status FROM payout_accounts WHERE artist_id = $1', [A]);
    expect(state.rows[0]).toEqual({ status: 'activo' });
  });

  it('un evento de una cuenta desconocida no tiene efecto', async () => {
    const apply = new ApplyAccountEventUseCase({ runner, clock, logger: new MemoryLogger() });
    const r = await apply.applyByProviderAccount('acct_NOPE', enabled(1));
    expect(r.ok && r.value).toBeNull();
  });

  it('webhook_events: la ingesta es idempotente por evento', async () => {
    const store = new PgWebhookEventStore(app);
    const payload = { providerAccountId: 'acct_X', occurredAt: 5 };
    const type = 'v2.core.account[requirements].updated';
    expect(await store.insertIfNew('stripe', 'evt_1', type, payload)).toBe(true);
    expect(await store.insertIfNew('stripe', 'evt_1', type, payload)).toBe(false);
    await store.markProcessed('stripe', 'evt_1');
    const row = await admin.query<{ status: string }>(
      "SELECT status FROM webhook_events WHERE event_id = 'evt_1'",
    );
    expect(row.rows[0]).toEqual({ status: 'processed' });
  });

  it('la lectura de elegibilidad y de datos publicos refleja el estado real', async () => {
    await readyArtistInDb(A, 'ana@example.com');
    await seedArtists();
    expect(await runner.run(artistScope(A), (r) => r.eligibility.get(A))).toEqual({
      profileComplete: true,
      hasAddress: true,
      payoutStatus: 'activo',
    });
    expect(await runner.run(systemScope, (r) => r.publicArtists.find(A))).toEqual({
      artisticName: 'Ana Art',
      instagram: 'ana',
    });
    expect(await runner.run(systemScope, (r) => r.eligibility.get(B))).toMatchObject({
      profileComplete: false,
      hasAddress: false,
    });
  });
});
