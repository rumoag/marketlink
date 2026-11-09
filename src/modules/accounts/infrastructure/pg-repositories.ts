import { instantOf, type Instant } from '@/modules/kernel/domain/clock';
import type { Email, PhoneES } from '@/modules/kernel/domain/formats';
import type { Queryable } from '@/modules/platform/infrastructure/pg-runner';
import type {
  AccountsRepos,
  ArtistRepository,
  PayoutAccountRepository,
  PayoutRecord,
  SenderAddressRepository,
} from '../application/ports';
import type { AddressInput, Artist, ProfileInput, SenderAddress } from '../domain/artist';
import type { InstagramHandle } from '../domain/instagram-handle';
import type { PayoutState, PayoutStatus, RequirementsHint } from '../domain/payout';
import type { PeninsularPostalCode } from '../domain/postal';

const at = (d: Date): Instant => instantOf(d.getTime());
const ts = (t: Instant): Date => new Date(t);

type ArtistRow = {
  id: string;
  email: string;
  artistic_name: string | null;
  instagram: string | null;
  phone: string | null;
  created_at: Date;
  updated_at: Date;
};

const toArtist = (r: ArtistRow): Artist => ({
  id: r.id,
  email: r.email as Email,
  artisticName: r.artistic_name ?? undefined,
  instagram: (r.instagram ?? undefined) as InstagramHandle | undefined,
  phone: (r.phone ?? undefined) as PhoneES | undefined,
  createdAt: at(r.created_at),
  updatedAt: at(r.updated_at),
});

export class PgArtistRepository implements ArtistRepository {
  constructor(private readonly q: Queryable) {}

  async findById(id: string): Promise<Artist | undefined> {
    const res = await this.q.query<ArtistRow>('SELECT * FROM artists WHERE id = $1', [id]);
    return res.rows[0] ? toArtist(res.rows[0]) : undefined;
  }

  async upsertOnSignIn(id: string, email: Email, now: Instant): Promise<Artist> {
    const res = await this.q.query<ArtistRow>(
      `INSERT INTO artists (id, email, created_at, updated_at) VALUES ($1, $2, $3, $3)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, email, ts(now)],
    );
    return toArtist(res.rows[0] as ArtistRow);
  }

  async saveProfile(id: string, profile: ProfileInput, now: Instant): Promise<Artist> {
    const res = await this.q.query<ArtistRow>(
      `UPDATE artists SET artistic_name = $2, instagram = $3, phone = $4, updated_at = $5
       WHERE id = $1 RETURNING *`,
      [id, profile.artisticName, profile.instagram, profile.phone, ts(now)],
    );
    return toArtist(res.rows[0] as ArtistRow);
  }
}

type AddressRow = {
  artist_id: string;
  street: string;
  number: string;
  floor_door: string;
  postal_code: string;
  city: string;
  province: string;
  phone: string;
};

const toAddress = (r: AddressRow): SenderAddress => ({
  artistId: r.artist_id,
  street: r.street,
  number: r.number,
  floorDoor: r.floor_door,
  postalCode: r.postal_code as PeninsularPostalCode,
  city: r.city,
  province: r.province,
  phone: r.phone as PhoneES,
  country: 'ES',
});

export class PgSenderAddressRepository implements SenderAddressRepository {
  constructor(private readonly q: Queryable) {}

  async find(artistId: string): Promise<SenderAddress | undefined> {
    const res = await this.q.query<AddressRow>(
      'SELECT * FROM sender_addresses WHERE artist_id = $1',
      [artistId],
    );
    return res.rows[0] ? toAddress(res.rows[0]) : undefined;
  }

  async save(artistId: string, a: AddressInput, now: Instant): Promise<SenderAddress> {
    const res = await this.q.query<AddressRow>(
      `INSERT INTO sender_addresses
         (artist_id, street, number, floor_door, postal_code, city, province, phone, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (artist_id) DO UPDATE SET
         street = EXCLUDED.street, number = EXCLUDED.number, floor_door = EXCLUDED.floor_door,
         postal_code = EXCLUDED.postal_code, city = EXCLUDED.city, province = EXCLUDED.province,
         phone = EXCLUDED.phone, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        artistId,
        a.street,
        a.number,
        a.floorDoor,
        a.postalCode,
        a.city,
        a.province,
        a.phone,
        ts(now),
      ],
    );
    return toAddress(res.rows[0] as AddressRow);
  }
}

type PayoutRow = {
  artist_id: string;
  provider_account_id: string | null;
  status: PayoutStatus;
  requirements_hint: RequirementsHint | null;
  last_event_at: Date | null;
};

const toRecord = (r: PayoutRow): PayoutRecord => {
  const state: PayoutState = {
    status: r.status,
    ...(r.requirements_hint !== null ? { requirementsHint: r.requirements_hint } : {}),
    ...(r.last_event_at !== null ? { lastEventAt: r.last_event_at.getTime() } : {}),
  };
  return {
    artistId: r.artist_id,
    providerAccountId: r.provider_account_id ?? undefined,
    state,
  };
};

export class PgPayoutAccountRepository implements PayoutAccountRepository {
  constructor(private readonly q: Queryable) {}

  async find(artistId: string): Promise<PayoutRecord | undefined> {
    const res = await this.q.query<PayoutRow>(
      'SELECT * FROM payout_accounts WHERE artist_id = $1',
      [artistId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : undefined;
  }

  async findByProviderAccountId(providerAccountId: string): Promise<PayoutRecord | undefined> {
    const res = await this.q.query<PayoutRow>(
      'SELECT * FROM payout_accounts WHERE provider_account_id = $1',
      [providerAccountId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : undefined;
  }

  async lockForUpdate(artistId: string): Promise<PayoutRecord> {
    await this.q.query(
      'INSERT INTO payout_accounts (artist_id) VALUES ($1) ON CONFLICT (artist_id) DO NOTHING',
      [artistId],
    );
    const res = await this.q.query<PayoutRow>(
      'SELECT * FROM payout_accounts WHERE artist_id = $1 FOR UPDATE',
      [artistId],
    );
    return toRecord(res.rows[0] as PayoutRow);
  }

  async setProviderAccount(
    artistId: string,
    providerAccountId: string,
    now: Instant,
  ): Promise<void> {
    await this.q.query(
      'UPDATE payout_accounts SET provider_account_id = $2, updated_at = $3 WHERE artist_id = $1',
      [artistId, providerAccountId, ts(now)],
    );
  }

  async saveState(artistId: string, state: PayoutState, now: Instant): Promise<void> {
    await this.q.query(
      `UPDATE payout_accounts
          SET status = $2, requirements_hint = $3, last_event_at = $4, updated_at = $5
        WHERE artist_id = $1`,
      [
        artistId,
        state.status,
        state.requirementsHint ?? null,
        state.lastEventAt !== undefined ? new Date(state.lastEventAt) : null,
        ts(now),
      ],
    );
  }
}

export const createAccountsRepos = (q: Queryable): AccountsRepos => ({
  artists: new PgArtistRepository(q),
  addresses: new PgSenderAddressRepository(q),
  payouts: new PgPayoutAccountRepository(q),
});
