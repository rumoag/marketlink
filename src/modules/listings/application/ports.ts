import type { AppError } from '@/modules/kernel/domain/app-error';
import type { Instant } from '@/modules/kernel/domain/clock';
import type { Result } from '@/modules/kernel/domain/result';
import type { Listing, ListingDraft } from '../domain/listing';
import type { PhotoError } from '../domain/photo-rules';
import type { Reservation } from '../domain/reservation';
import type { Slug } from '../domain/slug';

/** Subida lanzada por una colision de slug: la capa de aplicacion reintenta con otro. */
export class SlugTakenError extends Error {
  constructor() {
    super('slug_taken');
    this.name = 'SlugTakenError';
  }
}

export type StoredPhoto = {
  readonly id: string;
  readonly listingId: string;
  readonly artistId: string;
  readonly position: number;
  readonly storageKeyFull: string;
  readonly storageKeyThumb: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
};

export type PhotoUpload = {
  readonly id: string;
  readonly artistId: string;
  readonly storageKeyFull: string;
  readonly storageKeyThumb: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly status: 'pendiente' | 'consumida';
  readonly expiresAt: Instant;
};

export type PublicArtist = {
  readonly artisticName: string;
  readonly instagram: string;
};

export type SizePreset = {
  readonly size: 'S' | 'M' | 'L';
  readonly lengthCm: number;
  readonly widthCm: number;
  readonly heightCm: number;
  readonly weightKg: number;
  readonly exampleLabel: string;
};

/** Lo que LST necesita saber del artista para permitir crear o reanudar enlaces. */
export type ArtistEligibility = {
  readonly profileComplete: boolean;
  readonly hasAddress: boolean;
  readonly payoutStatus: 'sin_iniciar' | 'onboarding_pendiente' | 'activo' | 'restringido';
};

export interface ListingRepository {
  /** Lanza SlugTakenError si el slug ya existe. */
  insert(
    artistId: string,
    id: string,
    slug: Slug,
    draft: ListingDraft,
    now: Instant,
  ): Promise<Listing>;
  findById(id: string): Promise<Listing | undefined>;
  /** Igual que findById pero bloquea la fila hasta el fin de la transaccion. */
  findByIdForUpdate(id: string): Promise<Listing | undefined>;
  findBySlug(slug: Slug): Promise<Listing | undefined>;
  listByArtist(artistId: string): Promise<Listing[]>;
  /** Enlaces activos o pausados (los vendidos no cuentan). */
  countOpen(artistId: string): Promise<number>;
  save(listing: Listing): Promise<void>;
  /** BR2-CB10: pausa todos los activos del artista; devuelve cuantos. */
  pauseActiveForRestriction(artistId: string, now: Instant): Promise<number>;
}

export interface ListingPhotoRepository {
  insertMany(photos: readonly StoredPhoto[], now: Instant): Promise<void>;
  listByListing(listingId: string): Promise<StoredPhoto[]>;
  listByListings(listingIds: readonly string[]): Promise<StoredPhoto[]>;
  remove(id: string): Promise<void>;
  /** Reescribe las posiciones 1..n en el orden dado. */
  renumber(listingId: string, orderedIds: readonly string[]): Promise<void>;
}

export interface PhotoUploadRepository {
  insert(upload: PhotoUpload, now: Instant): Promise<void>;
  /** Subidas del artista, pendientes y vigentes, de entre los identificadores dados. */
  findPending(artistId: string, ids: readonly string[], now: Instant): Promise<PhotoUpload[]>;
  markConsumed(ids: readonly string[], now: Instant): Promise<void>;
  /** Pendientes caducadas (sistema), para la limpieza. */
  findExpired(now: Instant, limit: number): Promise<PhotoUpload[]>;
  delete(ids: readonly string[]): Promise<void>;
}

export interface ReservationRepository {
  /** Marca como expiradas las reservas activas vencidas del enlace. */
  expireDue(listingId: string, now: Instant): Promise<void>;
  findActive(listingId: string, now: Instant): Promise<Reservation | undefined>;
  findById(id: string): Promise<Reservation | undefined>;
  insert(reservation: Reservation, now: Instant): Promise<void>;
  update(reservation: Reservation, now: Instant): Promise<void>;
}

export interface SizePresetRepository {
  list(): Promise<SizePreset[]>;
}

export interface PublicArtistReader {
  find(artistId: string): Promise<PublicArtist | undefined>;
}

export interface EligibilityReader {
  get(artistId: string): Promise<ArtistEligibility>;
}

/** Candado consultivo por artista (P2-CON-1): serializa las altas del mismo artista. */
export interface ArtistLock {
  lock(artistId: string): Promise<void>;
}

export type ListingsRepos = {
  readonly listings: ListingRepository;
  readonly photos: ListingPhotoRepository;
  readonly uploads: PhotoUploadRepository;
  readonly reservations: ReservationRepository;
  readonly sizes: SizePresetRepository;
  readonly publicArtists: PublicArtistReader;
  readonly eligibility: EligibilityReader;
  readonly locks: ArtistLock;
};

export type ProcessedImage = {
  readonly full: { readonly bytes: Uint8Array; readonly width: number; readonly height: number };
  readonly thumb: { readonly bytes: Uint8Array; readonly width: number; readonly height: number };
};

/** Decodifica con limites, quita metadatos y genera los dos tamanos en WebP. */
export interface ImageProcessor {
  process(bytes: Uint8Array): Promise<Result<ProcessedImage, PhotoError>>;
}

/** Almacenamiento privado de fotos (Supabase Storage). */
export interface PhotoStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<Result<void, AppError>>;
  remove(keys: readonly string[]): Promise<Result<void, AppError>>;
  /** URLs firmadas de vida corta, en una sola llamada; la clave de salida es la de entrada. */
  signUrls(
    keys: readonly string[],
    ttlSeconds: number,
  ): Promise<Result<ReadonlyMap<string, string>, AppError>>;
}
