import { describe, expect, it } from 'vitest';
import { Email } from '@/modules/kernel/domain/formats';
import { MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { buildHarness } from '@tests/support/harness';

const email = (text: string) => unwrap(Email.parse(text));

describe('SignInService (US-001)', () => {
  it('la respuesta es la misma exista o no la cuenta y aunque el correo falle (BR2-AC2)', async () => {
    const h = buildHarness();
    await h.readyArtist('ana@example.com');
    const known = await h.signIn.requestMagicLink('ana@example.com', '1.1.1.1', 'c');
    const unknown = await h.signIn.requestMagicLink('nueva@example.com', '1.1.1.1', 'c');
    expect(known).toEqual(unknown);
    expect(known.ok).toBe(true);

    h.auth.failSend = true;
    const failing = await h.signIn.requestMagicLink('otra@example.com', '1.1.1.2', 'c');
    expect(failing.ok).toBe(true); // el usuario no ve el fallo
    expect(h.logger.entries.some((e) => e.message === 'magic_link_send_failed')).toBe(true);
  });

  it('un email mal formado es un error de validacion sin reflejar el valor', async () => {
    const h = buildHarness();
    const r = await h.signIn.requestMagicLink('no-es-un-email', '1.1.1.1', 'c');
    expect(!r.ok && r.error.code).toBe('validation');
    expect(JSON.stringify(r)).not.toContain('no-es-un-email');
  });

  it('la sexta peticion por email en una hora es 429 y deja AuditEvent', async () => {
    const h = buildHarness();
    for (let i = 0; i < 5; i++) {
      expect((await h.signIn.requestMagicLink('ana@example.com', `9.9.9.${i}`, 'c')).ok).toBe(true);
    }
    const sixth = await h.signIn.requestMagicLink('ana@example.com', '9.9.9.9', 'c');
    expect(!sixth.ok && sixth.error.code).toBe('rate_limited');
    expect(h.auditStore.events.some((e) => e.action === 'rate_limited')).toBe(true);
  });

  it('el limite por IP (20/h) tambien se aplica', async () => {
    const h = buildHarness();
    for (let i = 0; i < 20; i++) {
      expect((await h.signIn.requestMagicLink(`u${i}@example.com`, '8.8.8.8', 'c')).ok).toBe(true);
    }
    const r = await h.signIn.requestMagicLink('u99@example.com', '8.8.8.8', 'c');
    expect(!r.ok && r.error.code).toBe('rate_limited');
  });

  it('si el almacen de contadores falla no se envia el enlace (fallo cerrado)', async () => {
    const h = buildHarness();
    h.counters.failWith = new Error('db caida');
    const r = await h.signIn.requestMagicLink('ana@example.com', '1.1.1.1', 'c');
    expect(!r.ok && r.error.code).toBe('dependency_unavailable');
    expect(h.auth.sent).toHaveLength(0);
  });

  it('confirmar crea al artista; un enlace usado es generico y deja AuditEvent (BR2-AC5, AC6)', async () => {
    const h = buildHarness();
    const token = h.auth.issue(email('ana@example.com'));
    const first = unwrap(await h.signIn.completeSignIn(token, 'c'));
    expect(first.artist.email).toBe('ana@example.com');
    expect(first.session.accessToken).toBeTruthy();

    const reused = await h.signIn.completeSignIn(token, 'c');
    expect(!reused.ok && reused.error.code).toBe('unauthenticated');
    expect(h.auditStore.events.map((e) => e.action)).toContain('auth_failure');
  });

  it('una caida del proveedor al confirmar se puede reintentar', async () => {
    const h = buildHarness();
    h.auth.failVerifyAsDown = true;
    const r = await h.signIn.completeSignIn('x', 'c');
    expect(!r.ok && r.error.code).toBe('dependency_unavailable');
  });

  it('volver a entrar no duplica al artista', async () => {
    const h = buildHarness();
    await h.signIn.completeSignIn(h.auth.issue(email('ana@example.com')), 'c');
    await h.signIn.completeSignIn(h.auth.issue(email('ana@example.com')), 'c');
    expect(h.db.state.artists.size).toBe(1);
  });
});

describe('AccountService (US-002 a US-005)', () => {
  const profile = { artisticName: 'Ana Art', instagram: '@ana', phone: '612345678' };
  const address = {
    street: 'Calle Mayor',
    number: '1',
    postalCode: '28001',
    city: 'Madrid',
    province: 'Madrid',
    phone: '612345678',
  };

  const signedIn = async (h: ReturnType<typeof buildHarness>) =>
    unwrap(await h.signIn.completeSignIn(h.auth.issue(email('ana@example.com')), 'c')).artist.id;

  it('guarda el perfil y el panel indica el siguiente paso', async () => {
    const h = buildHarness();
    const id = await signedIn(h);
    expect(unwrap(await h.accounts.getOverview(id)).nextStep).toBe('perfil');
    unwrap(await h.accounts.saveProfile(id, profile, 'c'));
    expect(unwrap(await h.accounts.getOverview(id)).nextStep).toBe('direccion');
    unwrap(await h.accounts.saveSenderAddress(id, address, 'c'));
    expect(unwrap(await h.accounts.getOverview(id)).nextStep).toBe('cobros');
  });

  it('los errores de validacion nombran el campo y no reflejan el valor (BR-R5)', async () => {
    const h = buildHarness();
    const id = await signedIn(h);
    const r = await h.accounts.saveProfile(id, { ...profile, phone: '999-secreto-123' }, 'c');
    expect(!r.ok && r.error.code).toBe('validation');
    expect(!r.ok && r.error.details?.map((d) => d.field)).toContain('phone');
    expect(JSON.stringify(r)).not.toContain('secreto');
  });

  it('la direccion de Canarias o con provincia incorrecta se rechaza', async () => {
    const h = buildHarness();
    const id = await signedIn(h);
    const canarias = await h.accounts.saveSenderAddress(
      id,
      { ...address, postalCode: '35001', province: 'Las Palmas' },
      'c',
    );
    expect(!canarias.ok && canarias.error.details?.map((d) => d.field)).toContain('postalCode');
    const mismatch = await h.accounts.saveSenderAddress(
      id,
      { ...address, province: 'Barcelona' },
      'c',
    );
    expect(!mismatch.ok && mismatch.error.details?.map((d) => d.field)).toContain('province');
  });

  it('el onboarding exige perfil y direccion', async () => {
    const h = buildHarness();
    const id = await signedIn(h);
    const r = await h.accounts.startPayoutOnboarding(id, 'c');
    expect(!r.ok && r.error.code).toBe('conflict');
    expect(h.payout.createAccountCalls).toHaveLength(0);
  });

  it('crea la cuenta una sola vez y reanudar no pierde nada (BR2-CB3)', async () => {
    const h = buildHarness();
    const id = await signedIn(h);
    unwrap(await h.accounts.saveProfile(id, profile, 'c'));
    unwrap(await h.accounts.saveSenderAddress(id, address, 'c'));

    const first = unwrap(await h.accounts.startPayoutOnboarding(id, 'c'));
    const second = unwrap(await h.accounts.startPayoutOnboarding(id, 'c'));
    expect(first.url).toContain('https://onboarding.test/');
    expect(second.url).toBe(first.url);
    expect(h.payout.createAccountCalls).toHaveLength(1);
    expect(unwrap(await h.accounts.getOverview(id)).payout.status).toBe('onboarding_pendiente');
  });

  it('con los cobros activos no se vuelve a iniciar', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const r = await h.accounts.startPayoutOnboarding(id, 'c');
    expect(!r.ok && r.error.code).toBe('conflict');
  });

  it('el onboarding falla cerrado si el almacen de contadores cae y no llama al proveedor', async () => {
    const h = buildHarness();
    const id = await signedIn(h);
    unwrap(await h.accounts.saveProfile(id, profile, 'c'));
    unwrap(await h.accounts.saveSenderAddress(id, address, 'c'));
    h.counters.failWith = new Error('db caida');
    const r = await h.accounts.startPayoutOnboarding(id, 'c');
    expect(!r.ok && r.error.code).toBe('dependency_unavailable');
    expect(h.payout.createAccountCalls).toHaveLength(0);
  });

  it('el onboarding limita a 10 por hora', async () => {
    const h = buildHarness();
    const id = await signedIn(h);
    unwrap(await h.accounts.saveProfile(id, profile, 'c'));
    unwrap(await h.accounts.saveSenderAddress(id, address, 'c'));
    for (let i = 0; i < 10; i++) unwrap(await h.accounts.startPayoutOnboarding(id, 'c'));
    const r = await h.accounts.startPayoutOnboarding(id, 'c');
    expect(!r.ok && r.error.code).toBe('rate_limited');
  });

  it('al volver del onboarding se consulta el estado y pasa a activo', async () => {
    const h = buildHarness();
    const id = await signedIn(h);
    unwrap(await h.accounts.saveProfile(id, profile, 'c'));
    unwrap(await h.accounts.saveSenderAddress(id, address, 'c'));
    unwrap(await h.accounts.startPayoutOnboarding(id, 'c'));
    const accountId = [...h.db.state.payouts.values()][0]?.providerAccountId as string;
    h.payout.snapshots.set(accountId, h.enabledSnapshot(h.clock.now()));

    const view = unwrap(await h.accounts.refreshPayoutStatus(id, 'c'));
    expect(view.status).toBe('activo');
  });

  it('la vista de cobros nunca incluye el identificador de la cuenta (BR2-CB8)', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    h.db.state.payouts.set(id, {
      ...(h.db.state.payouts.get(id) as NonNullable<ReturnType<typeof h.db.state.payouts.get>>),
      providerAccountId: 'acct_SECRETA',
    });
    const overview = unwrap(await h.accounts.getOverview(id));
    expect(JSON.stringify(overview)).not.toContain('acct_SECRETA');
  });

  it('R-06: con Stripe caido, activar cobros falla de forma reintentable y el panel sigue operativo', async () => {
    const h = buildHarness();
    const id = await signedIn(h);
    unwrap(await h.accounts.saveProfile(id, profile, 'c'));
    unwrap(await h.accounts.saveSenderAddress(id, address, 'c'));

    h.payout.down = true;
    const down = await h.accounts.startPayoutOnboarding(id, 'c');
    expect(!down.ok && down.error).toMatchObject({
      code: 'dependency_unavailable',
      retryable: true,
    });
    expect((await h.accounts.getOverview(id)).ok).toBe(true); // el panel sigue funcionando
    expect(unwrap(await h.accounts.refreshPayoutStatus(id, 'c')).status).toBe('sin_iniciar');

    h.payout.down = false; // recuperacion sin intervencion
    expect(unwrap(await h.accounts.startPayoutOnboarding(id, 'c')).url).toContain(
      'onboarding.test',
    );
  });
});

describe('PhotoService (US-007) y R-07', () => {
  it('rechaza lo que no es imagen sin llamar al procesador', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const pdf = new TextEncoder().encode('%PDF-1.7');
    const r = await h.photos.upload(id, pdf, 'c');
    expect(!r.ok && r.error.details?.map((d) => d.field)).toContain('photos');
    expect(h.storage.objects.size).toBe(0);
  });

  it('una imagen ilegible se rechaza con mensaje generico', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    h.processor.failWith = 'unreadable';
    const r = await h.photos.upload(id, h.jpeg(), 'c');
    expect(!r.ok && r.error.code).toBe('validation');
    expect(h.storage.objects.size).toBe(0);
    expect(h.db.state.uploads.size).toBe(0);
  });

  it('guarda dos tamanos, registra la subida con caducidad de 24 h y devuelve una vista previa', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const up = unwrap(await h.photos.upload(id, h.jpeg(), 'c'));
    expect(h.storage.objects.size).toBe(2);
    const stored = [...h.db.state.uploads.values()][0];
    expect(stored?.expiresAt).toBe(h.clock.now() + 24 * MS.hour);
    expect(stored?.storageKeyFull.startsWith(`${id}/`)).toBe(true);
    expect(up.previewUrl).toContain('-480.webp');
  });

  it('limita las subidas a 30 por hora', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    for (let i = 0; i < 30; i++) unwrap(await h.photos.upload(id, h.jpeg(), 'c'));
    const r = await h.photos.upload(id, h.jpeg(), 'c');
    expect(!r.ok && r.error.code).toBe('rate_limited');
  });

  it('R-07: si falla Storage al guardar la miniatura, no queda nada a medias', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    h.storage.failPutOnCall = 2;
    const r = await h.photos.upload(id, h.jpeg(), 'c');
    expect(!r.ok && r.error.code).toBe('dependency_unavailable');
    expect(h.storage.objects.size).toBe(0);
    expect(h.db.state.uploads.size).toBe(0);
  });

  it('R-07: si falla la base al registrar la subida, se borran los objetos', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const original = h.db.run.bind(h.db);
    h.db.run = ((scope, fn) => {
      if (h.storage.objects.size === 2 && scope.kind === 'artist') {
        return Promise.reject(new Error('base caida'));
      }
      return original(scope, fn);
    }) as typeof h.db.run;
    await expect(h.photos.upload(id, h.jpeg(), 'c')).rejects.toThrow('base caida');
    expect(h.storage.objects.size).toBe(0);
  });

  it('la limpieza borra las subidas caducadas y sus objetos, y reintenta si Storage falla', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    await h.uploadPhotos(id, 2);
    expect(unwrap(await h.photos.cleanupExpiredUploads()).removed).toBe(0); // aun vigentes

    h.clock.advance(25 * MS.hour);
    h.storage.failRemove = true;
    expect((await h.photos.cleanupExpiredUploads()).ok).toBe(false);
    expect(h.db.state.uploads.size).toBe(2); // nada se pierde: se reintenta

    h.storage.failRemove = false;
    expect(unwrap(await h.photos.cleanupExpiredUploads()).removed).toBe(2);
    expect(h.db.state.uploads.size).toBe(0);
    expect(h.storage.objects.size).toBe(0);
  });
});

describe('ListingService (US-006 a US-013)', () => {
  it('crea el enlace activo con sus fotos y marca las subidas como consumidas', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const uploads = await h.uploadPhotos(id, 3);
    const listing = unwrap(await h.listings.createListing(id, h.validInput(), uploads, 'c'));
    expect(listing.status).toBe('activo');
    expect(listing.slug).toMatch(/^[a-z0-9]{8}$/);
    expect([...h.db.state.photos.values()].map((p) => p.position).sort()).toEqual([1, 2, 3]);
    expect([...h.db.state.uploads.values()].every((u) => u.status === 'consumida')).toBe(true);
  });

  it('exige cobros activos, perfil y direccion (BR2-LK1)', async () => {
    const h = buildHarness();
    const signed = unwrap(
      await h.signIn.completeSignIn(h.auth.issue(email('ana@example.com')), 'c'),
    );
    const r = await h.listings.createListing(signed.artist.id, h.validInput(), [], 'c');
    expect(!r.ok).toBe(true);
    // sin subidas el error es de validacion; con subidas pero sin cobros, conflicto
    const id = signed.artist.id;
    unwrap(
      await h.accounts.saveProfile(
        id,
        { artisticName: 'Ana', instagram: 'ana', phone: '612345678' },
        'c',
      ),
    );
    const ups = await h.uploadPhotos(id, 1).catch(() => []);
    const noPayout = await h.listings.createListing(id, h.validInput(), ups, 'c');
    expect(!noPayout.ok && noPayout.error.code).toBe('conflict');
  });

  it('rechaza cero fotos, mas de tres o subidas ajenas', async () => {
    const h = buildHarness();
    const ana = await h.readyArtist('ana@example.com');
    const berta = await h.readyArtist('berta@example.com');
    const none = await h.listings.createListing(ana, h.validInput(), [], 'c');
    expect(!none.ok && none.error.code).toBe('validation');

    const four = await h.uploadPhotos(ana, 4);
    const tooMany = await h.listings.createListing(ana, h.validInput(), four, 'c');
    expect(!tooMany.ok && tooMany.error.code).toBe('validation');

    const bertaUploads = await h.uploadPhotos(berta, 1);
    const stolen = await h.listings.createListing(ana, h.validInput(), bertaUploads, 'c');
    expect(!stolen.ok && stolen.error.code).toBe('validation');
    expect(h.db.state.listings.size).toBe(0);
  });

  it('una subida no se puede usar dos veces ni caducada', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const uploads = await h.uploadPhotos(id, 1);
    unwrap(await h.listings.createListing(id, h.validInput(), uploads, 'c'));
    const again = await h.listings.createListing(id, h.validInput(), uploads, 'c');
    expect(!again.ok && again.error.code).toBe('validation');

    const old = await h.uploadPhotos(id, 1);
    h.clock.advance(25 * MS.hour);
    const expired = await h.listings.createListing(id, h.validInput(), old, 'c');
    expect(!expired.ok && expired.error.code).toBe('validation');
  });

  it('ante una colision de slug se reintenta con otro (BR2-SL2)', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const first = unwrap(await h.createListing(id));
    h.db.forcedSlugCollisions.push(first.slug);
    const second = unwrap(await h.createListing(id));
    expect(second.slug).not.toBe(first.slug);
  });

  it('respeta el limite de enlaces abiertos y los vendidos no cuentan (BR2-LK3)', async () => {
    const h = buildHarness({ maxOpenListings: 2 });
    const id = await h.readyArtist();
    const a = unwrap(await h.createListing(id));
    unwrap(await h.createListing(id));
    const blocked = await h.createListing(id);
    expect(!blocked.ok && blocked.error.code).toBe('conflict');

    unwrap(await h.reservations.markSold(a.id, undefined));
    expect((await h.createListing(id)).ok).toBe(true);
  });

  it('R-07: si falla la insercion de fotos nada queda a medias y las subidas siguen pendientes', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const uploads = await h.uploadPhotos(id, 2);
    h.db.failAt = 'photos.insertMany';
    await expect(h.listings.createListing(id, h.validInput(), uploads, 'c')).rejects.toThrow();
    expect(h.db.state.listings.size).toBe(0);
    expect(h.db.state.photos.size).toBe(0);
    expect([...h.db.state.uploads.values()].every((u) => u.status === 'pendiente')).toBe(true);

    // El artista puede reintentar sin resubir, y lo que no se use lo limpia el trabajo diario.
    expect((await h.listings.createListing(id, h.validInput(), uploads, 'c')).ok).toBe(true);
    const orphan = await h.uploadPhotos(id, 1);
    expect(orphan).toHaveLength(1);
    h.clock.advance(25 * MS.hour);
    unwrap(await h.photos.cleanupExpiredUploads());
    expect(h.storage.objects.size).toBe(4); // solo las dos fotos del enlace (dos tamanos cada una)
  });

  it('pausar, reanudar y la regla de cobros (US-012)', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const listing = unwrap(await h.createListing(id));
    expect(unwrap(await h.listings.pause(id, listing.id)).pausedReason).toBe('artista');
    expect(unwrap(await h.listings.resume(id, listing.id)).status).toBe('activo');

    unwrap(await h.listings.pause(id, listing.id));
    unwrap(
      await h.apply.applySnapshot(
        id,
        { ...h.enabledSnapshot(h.clock.now() + 5), disabled: true },
        'c',
      ),
    );
    const blocked = await h.listings.resume(id, listing.id);
    expect(!blocked.ok && blocked.error.code).toBe('conflict');
  });

  it('un enlace vendido no se reactiva ni se edita (BR2-LK4)', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const listing = unwrap(await h.createListing(id));
    unwrap(await h.reservations.markSold(listing.id, 'order-1'));
    expect((await h.listings.resume(id, listing.id)).ok).toBe(false);
    expect((await h.listings.pause(id, listing.id)).ok).toBe(false);
    expect((await h.listings.updateListing(id, listing.id, { title: 'Otro titulo' })).ok).toBe(
      false,
    );
    expect(h.db.state.listings.get(listing.id)?.orderId).toBe('order-1');
  });

  it('con una reserva activa se puede cambiar el titulo pero no el precio (BR2-ED3)', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const listing = unwrap(await h.createListing(id));
    unwrap(await h.reservations.reserve(listing.id, 10 * MS.minute));

    expect((await h.listings.updateListing(id, listing.id, { title: 'Titulo nuevo' })).ok).toBe(
      true,
    );
    const blocked = await h.listings.updateListing(id, listing.id, { price: '999' });
    expect(!blocked.ok && blocked.error.code).toBe('conflict');

    h.clock.advance(11 * MS.minute); // la reserva vence y deja de bloquear
    expect((await h.listings.updateListing(id, listing.id, { price: '999' })).ok).toBe(true);
  });

  it('editar el precio arrastra el valor declarado si seguia igual (BR2-ED4)', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const listing = unwrap(await h.createListing(id, { price: '100' }));
    const next = unwrap(await h.listings.updateListing(id, listing.id, { price: '120' }));
    expect(next.declaredValueCents).toBe(12000);
    const custom = unwrap(await h.listings.updateListing(id, listing.id, { declaredValue: '80' }));
    expect(
      unwrap(await h.listings.updateListing(id, custom.id, { price: '150' })).declaredValueCents,
    ).toBe(8000);
  });

  it('la lista pide las miniaturas en una sola llamada y no incluye enlaces ajenos (US-013)', async () => {
    const h = buildHarness();
    const ana = await h.readyArtist('ana@example.com');
    const berta = await h.readyArtist('berta@example.com');
    await h.createListing(ana);
    await h.createListing(ana);
    await h.createListing(berta);
    h.storage.signCalls = 0;
    const mine = unwrap(await h.listings.listMine(ana));
    expect(mine).toHaveLength(2);
    expect(h.storage.signCalls).toBe(1);
    expect(mine.every((v) => v.listing.artistId === ana)).toBe(true);
    expect(mine[0]?.dmText.split('\n')).toHaveLength(3);
  });

  it('si no se pueden firmar las URL la lista sigue funcionando sin imagenes', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    await h.createListing(id);
    h.storage.failSign = true;
    const mine = unwrap(await h.listings.listMine(id));
    expect(mine[0]?.photos[0]?.thumbUrl).toBeUndefined();
  });

  it('no se puede quitar la ultima foto', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const listing = unwrap(await h.createListing(id));
    const photo = [...h.db.state.photos.values()][0];
    const r = await h.listings.removePhoto(id, listing.id, photo?.id as string);
    expect(!r.ok && r.error.code).toBe('validation');
    expect(h.db.state.photos.size).toBe(1);
  });

  it('vista publica: slug mal formado, activo, pausado y vendido (BR2-SL4, BR2-LK6)', async () => {
    const h = buildHarness();
    const id = await h.readyArtist();
    const listing = unwrap(await h.createListing(id, { title: 'Acuarela' }));

    const bad = await h.listings.getPublicView('no valido!');
    expect(!bad.ok && bad.error.code).toBe('not_found');

    const active = unwrap(await h.listings.getPublicView(listing.slug.toUpperCase()));
    expect(active).toMatchObject({
      available: true,
      title: 'Acuarela',
      artisticName: 'Ana Art',
      instagram: 'ana.art',
    });
    expect(active.photos[0]?.thumbUrl).toBeTruthy();
    expect(JSON.stringify(active)).not.toContain('612345678'); // nunca el telefono

    unwrap(await h.listings.pause(id, listing.id));
    const paused = unwrap(await h.listings.getPublicView(listing.slug));
    expect(paused).toMatchObject({ available: false, priceCents: undefined });
    expect(paused.photos).toHaveLength(0);

    const missing = await h.listings.getPublicView('abcdefgh');
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });

  it('lista los tamanos predefinidos', async () => {
    const h = buildHarness();
    const sizes = await h.listings.getSizePresets();
    expect(sizes.map((s) => s.size)).toEqual(['S', 'M', 'L']);
  });
});
