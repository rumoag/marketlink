import { z } from 'zod';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock, Random } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import { validate } from '@/modules/kernel/domain/validation';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { IdGenerator, Logger } from '@/modules/platform/application/ports';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import {
  artistScope,
  enforceLimit,
  systemScope,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import { buildDmText } from '../domain/dm';
import {
  applyPatch,
  canCreateMore,
  hasOrigins,
  listingInputSchema,
  listingPatchSchema,
  MAX_OPEN_LISTINGS,
  pause,
  resume,
  toDraft,
  type Listing,
  type ListingError,
  type Modality,
} from '../domain/listing';
import { canRemovePhoto, isValidPhotoCount, MAX_PHOTOS } from '../domain/photo-rules';
import { generateSlug, parseSlug } from '../domain/slug';
import { SIGNED_URL_TTL_SECONDS } from './photo-service';
import {
  SlugTakenError,
  type ListingsRepos,
  type PhotoStorage,
  type SizePreset,
  type StoredPhoto,
} from './ports';

const SLUG_ATTEMPTS = 5;

export type ListingServiceDeps = {
  readonly runner: TransactionRunner<ListingsRepos>;
  readonly storage: PhotoStorage;
  readonly limiter: Pick<RateLimiter, 'check'>;
  readonly audit: AuditLog;
  readonly random: Random;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly appUrl: string;
  readonly maxOpenListings?: number;
};

export type PhotoView = {
  readonly id: string;
  readonly position: number;
  readonly thumbUrl: string | undefined;
  readonly fullUrl: string | undefined;
};

export type ListingView = {
  readonly listing: Listing;
  readonly photos: readonly PhotoView[];
  readonly dmText: string;
  /** Hay un pago en curso: precio, valor declarado, tamano y modalidad no se pueden cambiar. */
  readonly reserved: boolean;
};

export type PublicListing = {
  readonly available: boolean;
  /** Estado del enlace: la pagina distingue «pausada» de «vendida» sin revelar el motivo. */
  readonly status: Listing['status'];
  readonly title: string;
  readonly description: string | undefined;
  readonly priceCents: number | undefined;
  readonly fragile: boolean | undefined;
  readonly artisticName: string | undefined;
  readonly instagram: string | undefined;
  readonly photos: readonly PhotoView[];
  /** Alguien esta pagando esta obra ahora mismo (reserva vigente). */
  readonly reserved: boolean;
  /** Modalidad de envio del enlace (solo si esta disponible). */
  readonly modality: Modality | undefined;
};

const uploadIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(MAX_PHOTOS)
  .refine((ids) => new Set(ids).size === ids.length);

/** Traduce un error de dominio del enlace a un AppError generico (sin detalles internos). */
const toAppError = (e: ListingError): AppError => {
  switch (e) {
    case 'sold':
    case 'reserved_fields':
    case 'payout_inactive':
    case 'invalid_transition':
    case 'limit_reached':
      return appError('conflict');
  }
};

export class ListingService {
  private readonly limit: number;

  constructor(private readonly deps: ListingServiceDeps) {
    this.limit = deps.maxOpenListings ?? MAX_OPEN_LISTINGS;
  }

  // ---------------------------------------------------------------------------------------
  // US-006: crear
  // ---------------------------------------------------------------------------------------
  async createListing(
    artistId: string,
    rawInput: unknown,
    rawUploadIds: unknown,
    correlationId: string,
  ): Promise<Result<Listing, AppError>> {
    const limited = await enforceLimit(this.deps.limiter, 'listing_create_artist', artistId, {
      failClosed: false,
      correlationId,
    });
    if (!limited.ok) return limited;

    const input = validate(listingInputSchema, rawInput);
    if (!input.ok) return input;
    if (!hasOrigins(input.value)) {
      return err(appError('validation', { details: [{ field: 'origins', reason: 'vacio' }] }));
    }
    const ids = validate(uploadIdsSchema, rawUploadIds);
    if (!ids.ok) {
      return err(appError('validation', { details: [{ field: 'photos', reason: 'invalido' }] }));
    }
    const draft = toDraft(input.value);

    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const slug = generateSlug(this.deps.random);
      try {
        const created = await this.deps.runner.run(artistScope(artistId), async (repos) => {
          // P2-CON-1: las altas del mismo artista se serializan; el recuento es exacto.
          await repos.locks.lock(artistId);

          const eligibility = await repos.eligibility.get(artistId);
          if (
            !eligibility.profileComplete ||
            !eligibility.hasAddress ||
            eligibility.payoutStatus !== 'activo'
          ) {
            return err(appError('conflict')); // BR2-LK1
          }
          if (!canCreateMore(await repos.listings.countOpen(artistId), this.limit)) {
            return err(appError('conflict')); // BR2-LK3
          }

          const now = this.deps.clock.now();
          const uploads = await repos.uploads.findPending(artistId, ids.value, now);
          if (uploads.length !== ids.value.length || !isValidPhotoCount(uploads.length)) {
            return err(
              appError('validation', { details: [{ field: 'photos', reason: 'invalido' }] }),
            );
          }

          const listing = await repos.listings.insert(
            artistId,
            this.deps.ids.uuid(),
            slug,
            draft,
            now,
          );
          // Se respeta el orden en que el artista envio las subidas.
          const byId = new Map(uploads.map((u) => [u.id, u]));
          const photos: StoredPhoto[] = ids.value.map((uploadId, index) => {
            const u = byId.get(uploadId) as NonNullable<ReturnType<typeof byId.get>>;
            return {
              id: this.deps.ids.uuid(),
              listingId: listing.id,
              artistId,
              position: index + 1,
              storageKeyFull: u.storageKeyFull,
              storageKeyThumb: u.storageKeyThumb,
              width: u.width,
              height: u.height,
              bytes: u.bytes,
            };
          });
          await repos.photos.insertMany(photos, now);
          await repos.uploads.markConsumed(ids.value, now);
          return ok(listing);
        });
        if (created.ok) {
          this.deps.logger.info('listing_created', { listingId: created.value.id, correlationId });
        }
        return created;
      } catch (cause) {
        if (cause instanceof SlugTakenError) continue; // BR2-SL2: otro slug
        throw cause;
      }
    }
    // BR2-SL2: agotados los intentos, error interno.
    return err(appError('internal'));
  }

  // ---------------------------------------------------------------------------------------
  // Edicion, pausa y reanudacion (US-012)
  // ---------------------------------------------------------------------------------------
  async updateListing(
    artistId: string,
    listingId: string,
    rawPatch: unknown,
  ): Promise<Result<Listing, AppError>> {
    const patch = validate(listingPatchSchema, rawPatch);
    if (!patch.ok) return patch;
    if (patch.value.origins !== undefined && patch.value.origins.length === 0) {
      return err(appError('validation', { details: [{ field: 'origins', reason: 'vacio' }] }));
    }

    return this.deps.runner.run(artistScope(artistId), async (repos) => {
      const current = await repos.listings.findByIdForUpdate(listingId);
      if (!current || current.artistId !== artistId) return err(appError('not_found')); // BR2-LK8
      const now = this.deps.clock.now();
      await repos.reservations.expireDue(current.id, now);
      const reserved = (await repos.reservations.findActive(current.id, now)) !== undefined;
      const next = applyPatch(current, patch.value, reserved, now);
      if (!next.ok) return err(toAppError(next.error));
      await repos.listings.save(next.value);
      return ok(next.value);
    });
  }

  async pause(artistId: string, listingId: string): Promise<Result<Listing, AppError>> {
    return this.deps.runner.run(artistScope(artistId), async (repos) => {
      const current = await repos.listings.findByIdForUpdate(listingId);
      if (!current || current.artistId !== artistId) return err(appError('not_found'));
      const next = pause(current, this.deps.clock.now());
      if (!next.ok) return err(toAppError(next.error));
      await repos.listings.save(next.value);
      return ok(next.value);
    });
  }

  async resume(artistId: string, listingId: string): Promise<Result<Listing, AppError>> {
    return this.deps.runner.run(artistScope(artistId), async (repos) => {
      const current = await repos.listings.findByIdForUpdate(listingId);
      if (!current || current.artistId !== artistId) return err(appError('not_found'));
      const eligibility = await repos.eligibility.get(artistId);
      const next = resume(current, eligibility.payoutStatus === 'activo', this.deps.clock.now());
      if (!next.ok) return err(toAppError(next.error));
      await repos.listings.save(next.value);
      return ok(next.value);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Fotos de un enlace existente
  // ---------------------------------------------------------------------------------------
  async addPhoto(
    artistId: string,
    listingId: string,
    uploadId: string,
  ): Promise<Result<void, AppError>> {
    return this.deps.runner.run(artistScope(artistId), async (repos) => {
      const listing = await repos.listings.findByIdForUpdate(listingId);
      if (!listing || listing.artistId !== artistId) return err(appError('not_found'));
      if (listing.status === 'vendido') return err(appError('conflict'));
      const existing = await repos.photos.listByListing(listingId);
      if (existing.length >= MAX_PHOTOS) {
        return err(appError('validation', { details: [{ field: 'photos', reason: 'invalido' }] }));
      }
      const now = this.deps.clock.now();
      const [upload] = await repos.uploads.findPending(artistId, [uploadId], now);
      if (!upload) {
        return err(appError('validation', { details: [{ field: 'photos', reason: 'invalido' }] }));
      }
      await repos.photos.insertMany(
        [
          {
            id: this.deps.ids.uuid(),
            listingId,
            artistId,
            position: existing.length + 1,
            storageKeyFull: upload.storageKeyFull,
            storageKeyThumb: upload.storageKeyThumb,
            width: upload.width,
            height: upload.height,
            bytes: upload.bytes,
          },
        ],
        now,
      );
      await repos.uploads.markConsumed([uploadId], now);
      return ok(undefined);
    });
  }

  /** BR2-FT6: nunca deja el enlace con menos de una foto; las posiciones quedan 1..n. */
  async removePhoto(
    artistId: string,
    listingId: string,
    photoId: string,
  ): Promise<Result<void, AppError>> {
    const removedKeys = await this.deps.runner.run(artistScope(artistId), async (repos) => {
      const listing = await repos.listings.findByIdForUpdate(listingId);
      if (!listing || listing.artistId !== artistId) return err(appError('not_found'));
      if (listing.status === 'vendido') return err(appError('conflict'));
      const photos = await repos.photos.listByListing(listingId);
      const target = photos.find((p) => p.id === photoId);
      if (!target) return err(appError('not_found'));
      if (!canRemovePhoto(photos.length)) {
        return err(appError('validation', { details: [{ field: 'photos', reason: 'invalido' }] }));
      }
      await repos.photos.remove(photoId);
      await repos.photos.renumber(
        listingId,
        photos.filter((p) => p.id !== photoId).map((p) => p.id),
      );
      return ok([target.storageKeyFull, target.storageKeyThumb]);
    });
    if (!removedKeys.ok) return removedKeys;
    // Primero la fila, despues el objeto: si el borrado falla, la limpieza lo recoge.
    const removed = await this.deps.storage.remove(removedKeys.value);
    if (!removed.ok) this.deps.logger.warn('photo_object_remove_failed');
    return ok(undefined);
  }

  // ---------------------------------------------------------------------------------------
  // Consultas
  // ---------------------------------------------------------------------------------------
  /** US-013: solo los enlaces del artista, con miniaturas firmadas en una sola llamada. */
  async listMine(artistId: string): Promise<Result<ListingView[], AppError>> {
    const data = await this.deps.runner.run(artistScope(artistId), async (repos) => {
      const listings = await repos.listings.listByArtist(artistId);
      const photos = await repos.photos.listByListings(listings.map((l) => l.id));
      return { listings, photos };
    });
    const urls = await this.signAll(data.photos, 'thumb');
    return ok(
      data.listings.map((listing) => ({
        listing,
        photos: this.toViews(
          data.photos.filter((p) => p.listingId === listing.id),
          urls,
          new Map(),
        ),
        dmText: buildDmText(listing, this.deps.appUrl),
        reserved: false,
      })),
    );
  }

  async getMine(artistId: string, listingId: string): Promise<Result<ListingView, AppError>> {
    const data = await this.deps.runner.run(artistScope(artistId), async (repos) => {
      const listing = await repos.listings.findById(listingId);
      if (!listing || listing.artistId !== artistId) return undefined;
      const reserved =
        (await repos.reservations.findActive(listingId, this.deps.clock.now())) !== undefined;
      return { listing, photos: await repos.photos.listByListing(listingId), reserved };
    });
    if (!data) return err(appError('not_found'));
    const thumbs = await this.signAll(data.photos, 'thumb');
    const fulls = await this.signAll(data.photos, 'full');
    return ok({
      listing: data.listing,
      photos: this.toViews(data.photos, thumbs, fulls),
      dmText: buildDmText(data.listing, this.deps.appUrl),
      reserved: data.reserved,
    });
  }

  /** US-011. */
  async getDmText(artistId: string, listingId: string): Promise<Result<string, AppError>> {
    const view = await this.getMine(artistId, listingId);
    return view.ok ? ok(view.value.dmText) : view;
  }

  async getSizePresets(): Promise<SizePreset[]> {
    return this.deps.runner.run(systemScope, (repos) => repos.sizes.list());
  }

  /**
   * BR2-SL4 y BR2-LK6: vista para el comprador. Un slug mal formado es «no encontrado» sin
   * consultar la base; un enlace pausado o vendido se muestra como no disponible.
   */
  async getPublicView(rawSlug: string): Promise<Result<PublicListing, AppError>> {
    const slug = parseSlug(rawSlug);
    if (!slug.ok) return err(appError('not_found'));

    const data = await this.deps.runner.run(systemScope, async (repos) => {
      const listing = await repos.listings.findBySlug(slug.value);
      if (!listing) return undefined;
      const artist = await repos.publicArtists.find(listing.artistId);
      const photos =
        listing.status === 'activo' ? await repos.photos.listByListing(listing.id) : [];
      const reserved =
        listing.status === 'activo' &&
        (await repos.reservations.findActive(listing.id, this.deps.clock.now())) !== undefined;
      return { listing, artist, photos, reserved };
    });
    if (!data) return err(appError('not_found'));

    const { listing, artist, photos, reserved } = data;
    if (listing.status !== 'activo') {
      return ok({
        available: false,
        status: listing.status,
        title: listing.title,
        description: undefined,
        priceCents: undefined,
        fragile: undefined,
        artisticName: artist?.artisticName,
        instagram: artist?.instagram,
        photos: [],
        reserved: false,
        modality: undefined,
      });
    }
    const thumbs = await this.signAll(photos, 'thumb');
    const fulls = await this.signAll(photos, 'full');
    return ok({
      available: true,
      status: listing.status,
      title: listing.title,
      description: listing.description,
      priceCents: listing.priceCents,
      fragile: listing.fragile,
      artisticName: artist?.artisticName,
      instagram: artist?.instagram,
      photos: this.toViews(photos, thumbs, fulls),
      reserved,
      modality: listing.modality,
    });
  }

  // ---------------------------------------------------------------------------------------
  private async signAll(
    photos: readonly StoredPhoto[],
    kind: 'thumb' | 'full',
  ): Promise<ReadonlyMap<string, string>> {
    if (photos.length === 0) return new Map();
    const keys = photos.map((p) => (kind === 'thumb' ? p.storageKeyThumb : p.storageKeyFull));
    const signed = await this.deps.storage.signUrls(keys, SIGNED_URL_TTL_SECONDS);
    // Sin URLs las pantallas siguen funcionando, solo sin imagen.
    return signed.ok ? signed.value : new Map();
  }

  private toViews(
    photos: readonly StoredPhoto[],
    thumbs: ReadonlyMap<string, string>,
    fulls: ReadonlyMap<string, string>,
  ): PhotoView[] {
    return [...photos]
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        id: p.id,
        position: p.position,
        thumbUrl: thumbs.get(p.storageKeyThumb),
        fullUrl: fulls.get(p.storageKeyFull),
      }));
  }
}
