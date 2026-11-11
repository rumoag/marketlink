import { instantOf, type Instant } from '@/modules/kernel/domain/clock';
import type { Queryable } from '@/modules/platform/infrastructure/pg-runner';
import {
  SlugTakenError,
  type ArtistEligibility,
  type ArtistLock,
  type EligibilityReader,
  type ListingPhotoRepository,
  type ListingRepository,
  type ListingsRepos,
  type PhotoUpload,
  type PhotoUploadRepository,
  type PublicArtist,
  type PublicArtistReader,
  type ReservationRepository,
  type SizePreset,
  type SizePresetRepository,
  type StoredPhoto,
} from '../application/ports';
import type {
  Listing,
  ListingDraft,
  ListingStatus,
  Modality,
  PackageSize,
  PausedReason,
} from '../domain/listing';
import { normalizeOrigins } from '../domain/listing';
import type { Reservation, ReservationStatus } from '../domain/reservation';
import type { Slug } from '../domain/slug';

const at = (d: Date): Instant => instantOf(d.getTime());
const ts = (t: Instant): Date => new Date(t);

// -------------------------------------------------------------------------------------------
type ListingRow = {
  id: string;
  artist_id: string;
  slug: string;
  title: string;
  description: string;
  price_cents: number;
  declared_value_cents: number;
  fragile: boolean;
  size: PackageSize;
  modality: Modality;
  origins: Modality[];
  status: ListingStatus;
  paused_reason: PausedReason | null;
  order_id: string | null;
  created_at: Date;
  updated_at: Date;
  sold_at: Date | null;
};

const toListing = (r: ListingRow): Listing => ({
  id: r.id,
  artistId: r.artist_id,
  slug: r.slug as Slug,
  title: r.title,
  description: r.description,
  priceCents: r.price_cents,
  declaredValueCents: r.declared_value_cents,
  fragile: r.fragile,
  size: r.size,
  modality: r.modality,
  origins: normalizeOrigins(r.origins),
  status: r.status,
  pausedReason: r.paused_reason ?? undefined,
  orderId: r.order_id ?? undefined,
  createdAt: at(r.created_at),
  updatedAt: at(r.updated_at),
  soldAt: r.sold_at ? at(r.sold_at) : undefined,
});

const isSlugConflict = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === '23505' &&
  (e as { constraint?: string }).constraint === 'listings_slug_key';

export class PgListingRepository implements ListingRepository {
  constructor(private readonly q: Queryable) {}

  async insert(
    artistId: string,
    id: string,
    slug: Slug,
    d: ListingDraft,
    now: Instant,
  ): Promise<Listing> {
    try {
      const res = await this.q.query<ListingRow>(
        `INSERT INTO listings
           (id, artist_id, slug, title, description, price_cents, declared_value_cents,
            fragile, size, modality, origins, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         RETURNING *`,
        [
          id,
          artistId,
          slug,
          d.title,
          d.description,
          d.priceCents,
          d.declaredValueCents,
          d.fragile,
          d.size,
          d.modality,
          [...d.origins],
          ts(now),
        ],
      );
      return toListing(res.rows[0] as ListingRow);
    } catch (e) {
      if (isSlugConflict(e)) throw new SlugTakenError();
      throw e;
    }
  }

  async findById(id: string): Promise<Listing | undefined> {
    const res = await this.q.query<ListingRow>('SELECT * FROM listings WHERE id = $1', [id]);
    return res.rows[0] ? toListing(res.rows[0]) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Listing | undefined> {
    const res = await this.q.query<ListingRow>('SELECT * FROM listings WHERE id = $1 FOR UPDATE', [
      id,
    ]);
    return res.rows[0] ? toListing(res.rows[0]) : undefined;
  }

  async findBySlug(slug: Slug): Promise<Listing | undefined> {
    const res = await this.q.query<ListingRow>('SELECT * FROM listings WHERE slug = $1', [slug]);
    return res.rows[0] ? toListing(res.rows[0]) : undefined;
  }

  async listByArtist(artistId: string): Promise<Listing[]> {
    const res = await this.q.query<ListingRow>(
      'SELECT * FROM listings WHERE artist_id = $1 ORDER BY created_at DESC',
      [artistId],
    );
    return res.rows.map(toListing);
  }

  async countOpen(artistId: string): Promise<number> {
    const res = await this.q.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM listings WHERE artist_id = $1 AND status <> 'vendido'`,
      [artistId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async save(l: Listing): Promise<void> {
    await this.q.query(
      `UPDATE listings SET
         title = $2, description = $3, price_cents = $4, declared_value_cents = $5,
         fragile = $6, size = $7, modality = $8, origins = $14, status = $9, paused_reason = $10,
         order_id = $11, updated_at = $12, sold_at = $13
       WHERE id = $1`,
      [
        l.id,
        l.title,
        l.description,
        l.priceCents,
        l.declaredValueCents,
        l.fragile,
        l.size,
        l.modality,
        l.status,
        l.pausedReason ?? null,
        l.orderId ?? null,
        ts(l.updatedAt),
        l.soldAt !== undefined ? ts(l.soldAt) : null,
        [...l.origins],
      ],
    );
  }

  async pauseActiveForRestriction(artistId: string, now: Instant): Promise<number> {
    const res = await this.q.query(
      `UPDATE listings
          SET status = 'pausado', paused_reason = 'cobros_restringidos', updated_at = $2
        WHERE artist_id = $1 AND status = 'activo'`,
      [artistId, ts(now)],
    );
    return res.rowCount ?? 0;
  }
}

// -------------------------------------------------------------------------------------------
type PhotoRow = {
  id: string;
  listing_id: string;
  artist_id: string;
  position: number;
  storage_key_full: string;
  storage_key_thumb: string;
  width: number;
  height: number;
  bytes: number;
};

const toPhoto = (r: PhotoRow): StoredPhoto => ({
  id: r.id,
  listingId: r.listing_id,
  artistId: r.artist_id,
  position: r.position,
  storageKeyFull: r.storage_key_full,
  storageKeyThumb: r.storage_key_thumb,
  width: r.width,
  height: r.height,
  bytes: r.bytes,
});

export class PgListingPhotoRepository implements ListingPhotoRepository {
  constructor(private readonly q: Queryable) {}

  async insertMany(photos: readonly StoredPhoto[], now: Instant): Promise<void> {
    for (const p of photos) {
      await this.q.query(
        `INSERT INTO listing_photos
           (id, listing_id, artist_id, position, storage_key_full, storage_key_thumb,
            width, height, bytes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          p.id,
          p.listingId,
          p.artistId,
          p.position,
          p.storageKeyFull,
          p.storageKeyThumb,
          p.width,
          p.height,
          p.bytes,
          ts(now),
        ],
      );
    }
  }

  async listByListing(listingId: string): Promise<StoredPhoto[]> {
    const res = await this.q.query<PhotoRow>(
      'SELECT * FROM listing_photos WHERE listing_id = $1 ORDER BY position',
      [listingId],
    );
    return res.rows.map(toPhoto);
  }

  async listByListings(listingIds: readonly string[]): Promise<StoredPhoto[]> {
    if (listingIds.length === 0) return [];
    const res = await this.q.query<PhotoRow>(
      'SELECT * FROM listing_photos WHERE listing_id = ANY($1::uuid[]) ORDER BY listing_id, position',
      [[...listingIds]],
    );
    return res.rows.map(toPhoto);
  }

  async remove(id: string): Promise<void> {
    await this.q.query('DELETE FROM listing_photos WHERE id = $1', [id]);
  }

  async renumber(_listingId: string, orderedIds: readonly string[]): Promise<void> {
    // La restriccion de posicion es diferible: se comprueba al final de la transaccion.
    for (const [index, id] of orderedIds.entries()) {
      await this.q.query('UPDATE listing_photos SET position = $2 WHERE id = $1', [id, index + 1]);
    }
  }
}

// -------------------------------------------------------------------------------------------
type UploadRow = {
  id: string;
  artist_id: string;
  storage_key_full: string;
  storage_key_thumb: string;
  width: number;
  height: number;
  bytes: number;
  status: 'pendiente' | 'consumida';
  expires_at: Date;
};

const toUpload = (r: UploadRow): PhotoUpload => ({
  id: r.id,
  artistId: r.artist_id,
  storageKeyFull: r.storage_key_full,
  storageKeyThumb: r.storage_key_thumb,
  width: r.width,
  height: r.height,
  bytes: r.bytes,
  status: r.status,
  expiresAt: at(r.expires_at),
});

export class PgPhotoUploadRepository implements PhotoUploadRepository {
  constructor(private readonly q: Queryable) {}

  async insert(u: PhotoUpload, now: Instant): Promise<void> {
    await this.q.query(
      `INSERT INTO photo_uploads
         (id, artist_id, storage_key_full, storage_key_thumb, width, height, bytes,
          status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        u.id,
        u.artistId,
        u.storageKeyFull,
        u.storageKeyThumb,
        u.width,
        u.height,
        u.bytes,
        u.status,
        ts(u.expiresAt),
        ts(now),
      ],
    );
  }

  async findPending(
    artistId: string,
    ids: readonly string[],
    now: Instant,
  ): Promise<PhotoUpload[]> {
    if (ids.length === 0) return [];
    const res = await this.q.query<UploadRow>(
      `SELECT * FROM photo_uploads
        WHERE artist_id = $1 AND id = ANY($2::uuid[]) AND status = 'pendiente' AND expires_at > $3
        FOR UPDATE`,
      [artistId, [...ids], ts(now)],
    );
    return res.rows.map(toUpload);
  }

  async markConsumed(ids: readonly string[], now: Instant): Promise<void> {
    if (ids.length === 0) return;
    await this.q.query(
      `UPDATE photo_uploads SET status = 'consumida', consumed_at = $2 WHERE id = ANY($1::uuid[])`,
      [[...ids], ts(now)],
    );
  }

  async findExpired(now: Instant, limit: number): Promise<PhotoUpload[]> {
    const res = await this.q.query<UploadRow>(
      `SELECT * FROM photo_uploads WHERE status = 'pendiente' AND expires_at <= $1
        ORDER BY expires_at LIMIT $2`,
      [ts(now), limit],
    );
    return res.rows.map(toUpload);
  }

  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.q.query('DELETE FROM photo_uploads WHERE id = ANY($1::uuid[])', [[...ids]]);
  }
}

// -------------------------------------------------------------------------------------------
type ReservationRow = {
  id: string;
  listing_id: string;
  artist_id: string;
  status: ReservationStatus;
  expires_at: Date;
};

const toReservation = (r: ReservationRow): Reservation => ({
  id: r.id,
  listingId: r.listing_id,
  artistId: r.artist_id,
  status: r.status,
  expiresAt: at(r.expires_at),
});

export class PgReservationRepository implements ReservationRepository {
  constructor(private readonly q: Queryable) {}

  async expireDue(listingId: string, now: Instant): Promise<void> {
    await this.q.query(
      `UPDATE reservations SET status = 'expirada', updated_at = $2
        WHERE listing_id = $1 AND status = 'activa' AND expires_at <= $2`,
      [listingId, ts(now)],
    );
  }

  async findActive(listingId: string, now: Instant): Promise<Reservation | undefined> {
    const res = await this.q.query<ReservationRow>(
      `SELECT * FROM reservations WHERE listing_id = $1 AND status = 'activa' AND expires_at > $2`,
      [listingId, ts(now)],
    );
    return res.rows[0] ? toReservation(res.rows[0]) : undefined;
  }

  async findById(id: string): Promise<Reservation | undefined> {
    const res = await this.q.query<ReservationRow>('SELECT * FROM reservations WHERE id = $1', [
      id,
    ]);
    return res.rows[0] ? toReservation(res.rows[0]) : undefined;
  }

  async insert(r: Reservation, now: Instant): Promise<void> {
    await this.q.query(
      `INSERT INTO reservations (id, listing_id, artist_id, status, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [r.id, r.listingId, r.artistId, r.status, ts(r.expiresAt), ts(now)],
    );
  }

  async update(r: Reservation, now: Instant): Promise<void> {
    await this.q.query('UPDATE reservations SET status = $2, updated_at = $3 WHERE id = $1', [
      r.id,
      r.status,
      ts(now),
    ]);
  }
}

// -------------------------------------------------------------------------------------------
export class PgSizePresetRepository implements SizePresetRepository {
  constructor(private readonly q: Queryable) {}

  async list(): Promise<SizePreset[]> {
    const res = await this.q.query<{
      size: 'S' | 'M' | 'L';
      length_cm: number;
      width_cm: number;
      height_cm: number;
      weight_kg: string;
      example_label: string;
    }>('SELECT * FROM size_presets ORDER BY size DESC');
    // El orden alfabetico inverso de 'S','M','L' no es el natural: se ordena aqui.
    const order = { S: 0, M: 1, L: 2 } as const;
    return res.rows
      .map((r) => ({
        size: r.size,
        lengthCm: r.length_cm,
        widthCm: r.width_cm,
        heightCm: r.height_cm,
        weightKg: Number(r.weight_kg),
        exampleLabel: r.example_label,
      }))
      .sort((a, b) => order[a.size] - order[b.size]);
  }
}

export class PgPublicArtistReader implements PublicArtistReader {
  constructor(private readonly q: Queryable) {}

  async find(artistId: string): Promise<PublicArtist | undefined> {
    const res = await this.q.query<{ artistic_name: string | null; instagram: string | null }>(
      'SELECT artistic_name, instagram FROM artists WHERE id = $1',
      [artistId],
    );
    const row = res.rows[0];
    if (!row?.artistic_name || !row.instagram) return undefined;
    return { artisticName: row.artistic_name, instagram: row.instagram };
  }
}

export class PgEligibilityReader implements EligibilityReader {
  constructor(private readonly q: Queryable) {}

  async get(artistId: string): Promise<ArtistEligibility> {
    const res = await this.q.query<{
      profile_complete: boolean;
      has_address: boolean;
      payout_status: ArtistEligibility['payoutStatus'];
    }>(
      `SELECT
         (a.artistic_name IS NOT NULL AND a.instagram IS NOT NULL AND a.phone IS NOT NULL) AS profile_complete,
         EXISTS (SELECT 1 FROM sender_addresses s WHERE s.artist_id = a.id) AS has_address,
         COALESCE((SELECT p.status FROM payout_accounts p WHERE p.artist_id = a.id), 'sin_iniciar') AS payout_status
       FROM artists a WHERE a.id = $1`,
      [artistId],
    );
    const row = res.rows[0];
    if (!row) return { profileComplete: false, hasAddress: false, payoutStatus: 'sin_iniciar' };
    return {
      profileComplete: row.profile_complete,
      hasAddress: row.has_address,
      payoutStatus: row.payout_status,
    };
  }
}

/** Candado consultivo de transaccion por artista (P2-CON-1). */
export class PgArtistLock implements ArtistLock {
  constructor(private readonly q: Queryable) {}

  async lock(artistId: string): Promise<void> {
    await this.q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `artist:${artistId}`,
    ]);
  }
}

export const createListingsRepos = (q: Queryable): ListingsRepos => ({
  listings: new PgListingRepository(q),
  photos: new PgListingPhotoRepository(q),
  uploads: new PgPhotoUploadRepository(q),
  reservations: new PgReservationRepository(q),
  sizes: new PgSizePresetRepository(q),
  publicArtists: new PgPublicArtistReader(q),
  eligibility: new PgEligibilityReader(q),
  locks: new PgArtistLock(q),
});
