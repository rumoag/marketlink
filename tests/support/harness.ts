import { AccountService } from '@/modules/accounts/application/account-service';
import { SignInService } from '@/modules/accounts/application/sign-in-service';
import { ListingService } from '@/modules/listings/application/listing-service';
import { PhotoService } from '@/modules/listings/application/photo-service';
import { ReservationService } from '@/modules/listings/application/reservation-service';
import { Email } from '@/modules/kernel/domain/formats';
import { unwrap } from '@/modules/kernel/domain/result';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { RateLimiter } from '@/modules/platform/application/rate-limiter';
import { ApplyAccountEventUseCase } from '@/services/apply-account-event';
import { FakeClock } from './generators';
import { MemoryAuditStore, MemoryCounterStore, MemoryLogger } from './fakes';
import { MemoryDb } from './memory-repos';
import { SeqIds, SeqRandom, StubAuth, StubPayout, StubProcessor, StubStorage } from './stubs';

/** Todo cableado con dobles en memoria: la misma composicion que produccion, sin red ni base. */
export const buildHarness = (options: { maxOpenListings?: number } = {}) => {
  const clock = new FakeClock(Date.UTC(2026, 10, 5, 10, 0, 0));
  const ids = new SeqIds();
  const db = new MemoryDb({ clock, ids });
  const logger = new MemoryLogger();
  const auditStore = new MemoryAuditStore();
  const audit = new AuditLog(auditStore, logger, clock);
  const counters = new MemoryCounterStore();
  const limiter = new RateLimiter({ store: counters, hasher: (_r, s) => s, clock, audit, logger });
  const random = new SeqRandom();
  const auth = new StubAuth();
  const payout = new StubPayout();
  const storage = new StubStorage();
  const processor = new StubProcessor();

  const apply = new ApplyAccountEventUseCase({ runner: db, clock, logger });
  const signIn = new SignInService({ auth, runner: db, limiter, audit, clock, logger });
  const accounts = new AccountService({
    runner: db,
    limiter,
    payoutProvider: payout,
    applier: apply,
    clock,
    logger,
    appUrl: 'https://app.test',
  });
  const photos = new PhotoService({ runner: db, storage, processor, limiter, ids, clock, logger });
  const listings = new ListingService({
    runner: db,
    storage,
    limiter,
    audit,
    random,
    ids,
    clock,
    logger,
    appUrl: 'https://app.test',
    ...(options.maxOpenListings !== undefined ? { maxOpenListings: options.maxOpenListings } : {}),
  });
  const reservations = new ReservationService({ runner: db, ids, clock });

  const harness = {
    clock,
    db,
    logger,
    auditStore,
    audit,
    counters,
    limiter,
    ids,
    random,
    auth,
    payout,
    storage,
    processor,
    apply,
    signIn,
    accounts,
    photos,
    listings,
    reservations,
  };

  /** Bytes con firma JPEG valida (el procesador de pruebas no decodifica). */
  const jpeg = (size = 64): Uint8Array => {
    const bytes = new Uint8Array(size);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    return bytes;
  };

  const enabledSnapshot = (eventAt: number) => ({
    detailsSubmitted: true,
    transfersActive: true,
    payoutsEnabled: true,
    disabled: false,
    eventAt,
  });

  /** Crea un artista listo para vender: perfil, direccion y cobros activos. */
  const readyArtist = async (emailText = 'ana@example.com') => {
    const email = unwrap(Email.parse(emailText));
    const signed = unwrap(await signIn.completeSignIn(auth.issue(email), 'c'));
    const artistId = signed.artist.id;
    unwrap(
      await accounts.saveProfile(
        artistId,
        { artisticName: 'Ana Art', instagram: '@ana.art', phone: '612 345 678' },
        'c',
      ),
    );
    unwrap(
      await accounts.saveSenderAddress(
        artistId,
        {
          street: 'Calle Mayor',
          number: '12',
          postalCode: '28001',
          city: 'Madrid',
          province: 'Madrid',
          phone: '612345678',
        },
        'c',
      ),
    );
    unwrap(await apply.applySnapshot(artistId, enabledSnapshot(clock.now()), 'c'));
    return artistId;
  };

  const uploadPhotos = async (artistId: string, count: number): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      out.push(unwrap(await photos.upload(artistId, jpeg(), 'c')).uploadId);
    }
    return out;
  };

  const validInput = (overrides: Record<string, unknown> = {}) => ({
    title: 'Oleo sobre lienzo',
    description: 'Una obra',
    price: '250',
    size: 'M',
    modality: 'punto',
    ...overrides,
  });

  const createListing = async (artistId: string, overrides: Record<string, unknown> = {}) => {
    const uploadIds = await uploadPhotos(artistId, 1);
    return listings.createListing(artistId, validInput(overrides), uploadIds, 'c');
  };

  return {
    ...harness,
    jpeg,
    enabledSnapshot,
    readyArtist,
    uploadPhotos,
    validInput,
    createListing,
  };
};

export type Harness = ReturnType<typeof buildHarness>;
