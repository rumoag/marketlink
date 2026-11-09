import { instantOf, type Instant } from '@/modules/kernel/domain/clock';
import type {
  LedgerBucket,
  LedgerEntry,
  LedgerEntryRow,
  LedgerKind,
} from '@/modules/ledger/domain/ledger';
import type { Queryable } from '@/modules/platform/infrastructure/pg-runner';
import type {
  BalanceRepository,
  LedgerRepository,
  RefundRepository,
  SettlementRepository,
  WithdrawalRepository,
} from '../application/ports';
import type { ArtistBalance, Refund, Settlement, Withdrawal } from '../domain/entities';
import type {
  RefundStatus,
  SettlementBlock,
  SettlementStatus,
  WithdrawalStatus,
} from '../domain/payouts';

const at = (d: Date): Instant => instantOf(d.getTime());
const ts = (t: Instant): Date => new Date(t);
const opt = <T>(v: T | null): T | undefined => v ?? undefined;

// ---------------------------------------------------------------------------------------------
// Libro
// ---------------------------------------------------------------------------------------------
type LedgerRow = {
  at: Date;
  order_id: string | null;
  artist_id: string | null;
  kind: LedgerKind;
  bucket: LedgerBucket;
  delta_cents: number;
  ref: string | null;
  reason_code: string | null;
  entry_key: string;
};

const toLedgerRow = (r: LedgerRow): LedgerEntryRow => ({
  at: at(r.at),
  orderId: opt(r.order_id),
  artistId: opt(r.artist_id),
  kind: r.kind,
  bucket: r.bucket,
  deltaCents: r.delta_cents,
  ref: opt(r.ref),
  reasonCode: opt(r.reason_code),
  entryKey: r.entry_key,
});

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly q: Queryable) {}

  async insertMany(entries: readonly LedgerEntry[], now: Instant): Promise<readonly string[]> {
    const inserted: string[] = [];
    for (const e of entries) {
      const res = await this.q.query(
        `INSERT INTO ledger_entries
           (at, order_id, artist_id, kind, bucket, delta_cents, ref, reason_code, entry_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [
          ts(now),
          e.orderId ?? null,
          e.artistId ?? null,
          e.kind,
          e.bucket,
          e.deltaCents,
          e.ref ?? null,
          e.reasonCode ?? null,
          e.entryKey,
        ],
      );
      if ((res.rowCount ?? 0) > 0) inserted.push(e.entryKey);
    }
    return inserted;
  }

  async listByOrder(orderId: string): Promise<LedgerEntryRow[]> {
    const res = await this.q.query<LedgerRow>(
      'SELECT * FROM ledger_entries WHERE order_id = $1 ORDER BY at, id',
      [orderId],
    );
    return res.rows.map(toLedgerRow);
  }

  async listByArtist(artistId: string, limit: number): Promise<LedgerEntryRow[]> {
    const res = await this.q.query<LedgerRow>(
      `SELECT * FROM ledger_entries WHERE artist_id = $1 AND bucket IN ('retenido', 'disponible')
        ORDER BY at DESC, id DESC LIMIT $2`,
      [artistId, limit],
    );
    return res.rows.map(toLedgerRow);
  }

  async sumsByArtist(): Promise<
    { artistId: string; retainedCents: number; availableCents: number }[]
  > {
    const res = await this.q.query<{ artist_id: string; retained: string; available: string }>(
      `SELECT artist_id,
              COALESCE(SUM(delta_cents) FILTER (WHERE bucket = 'retenido'), 0) AS retained,
              COALESCE(SUM(delta_cents) FILTER (WHERE bucket = 'disponible'), 0) AS available
         FROM ledger_entries WHERE artist_id IS NOT NULL GROUP BY artist_id`,
    );
    return res.rows.map((r) => ({
      artistId: r.artist_id,
      retainedCents: Number(r.retained),
      availableCents: Number(r.available),
    }));
  }

  async orderGaps(): Promise<{ orderId: string; gapCents: number }[]> {
    const res = await this.q.query<{ order_id: string; gap: string }>(
      `SELECT order_id,
              COALESCE(SUM(delta_cents) FILTER (WHERE bucket = 'stripe'), 0)
              - COALESCE(SUM(delta_cents) FILTER (WHERE bucket <> 'stripe'), 0) AS gap
         FROM ledger_entries WHERE order_id IS NOT NULL
        GROUP BY order_id HAVING
              COALESCE(SUM(delta_cents) FILTER (WHERE bucket = 'stripe'), 0)
              <> COALESCE(SUM(delta_cents) FILTER (WHERE bucket <> 'stripe'), 0)`,
    );
    return res.rows.map((r) => ({ orderId: r.order_id, gapCents: Number(r.gap) }));
  }

  async listBetween(from: Instant, to: Instant): Promise<LedgerEntryRow[]> {
    const res = await this.q.query<LedgerRow>(
      'SELECT * FROM ledger_entries WHERE at >= $1 AND at < $2 ORDER BY at, id',
      [ts(from), ts(to)],
    );
    return res.rows.map(toLedgerRow);
  }
}

// ---------------------------------------------------------------------------------------------
// Saldos
// ---------------------------------------------------------------------------------------------
type BalanceRow = {
  artist_id: string;
  retained_cents: number;
  available_cents: number;
  withdrawal_count: number;
};
const toBalance = (r: BalanceRow): ArtistBalance => ({
  artistId: r.artist_id,
  retainedCents: r.retained_cents,
  availableCents: r.available_cents,
  withdrawalCount: r.withdrawal_count,
});

export class PgBalanceRepository implements BalanceRepository {
  constructor(private readonly q: Queryable) {}

  async lock(artistId: string): Promise<ArtistBalance> {
    await this.q.query(
      'INSERT INTO artist_balances (artist_id) VALUES ($1) ON CONFLICT (artist_id) DO NOTHING',
      [artistId],
    );
    const res = await this.q.query<BalanceRow>(
      'SELECT * FROM artist_balances WHERE artist_id = $1 FOR UPDATE',
      [artistId],
    );
    return toBalance(res.rows[0] as BalanceRow);
  }

  async find(artistId: string): Promise<ArtistBalance | undefined> {
    const res = await this.q.query<BalanceRow>(
      'SELECT * FROM artist_balances WHERE artist_id = $1',
      [artistId],
    );
    return res.rows[0] ? toBalance(res.rows[0]) : undefined;
  }

  async save(b: ArtistBalance, now: Instant): Promise<void> {
    await this.q.query(
      `UPDATE artist_balances
          SET retained_cents = $2, available_cents = $3, withdrawal_count = $4, updated_at = $5
        WHERE artist_id = $1`,
      [b.artistId, b.retainedCents, b.availableCents, b.withdrawalCount, ts(now)],
    );
  }

  async listAll(): Promise<ArtistBalance[]> {
    const res = await this.q.query<BalanceRow>('SELECT * FROM artist_balances');
    return res.rows.map(toBalance);
  }
}

// ---------------------------------------------------------------------------------------------
// Liquidaciones
// ---------------------------------------------------------------------------------------------
type SettlementRow = {
  id: string;
  order_id: string;
  artist_id: string;
  amount_cents: number;
  status: SettlementStatus;
  block_reason: SettlementBlock | null;
  transfer_ref: string | null;
  attempts: number;
  next_attempt_at: Date;
  released_by: 'automatica' | 'manual' | null;
  alerted_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
  updated_at: Date;
};

const toSettlement = (r: SettlementRow): Settlement => ({
  id: r.id,
  orderId: r.order_id,
  artistId: r.artist_id,
  amountCents: r.amount_cents,
  status: r.status,
  blockReason: opt(r.block_reason),
  transferRef: opt(r.transfer_ref),
  attempts: r.attempts,
  nextAttemptAt: at(r.next_attempt_at),
  releasedBy: opt(r.released_by),
  alertedAt: r.alerted_at ? at(r.alerted_at) : undefined,
  createdAt: at(r.created_at),
  completedAt: r.completed_at ? at(r.completed_at) : undefined,
  updatedAt: at(r.updated_at),
});

export class PgSettlementRepository implements SettlementRepository {
  constructor(private readonly q: Queryable) {}

  async insertIfAbsent(s: Settlement): Promise<boolean> {
    const res = await this.q.query(
      `INSERT INTO settlements
         (id, order_id, artist_id, amount_cents, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pendiente', 0, $5, $6, $6)
       ON CONFLICT (order_id) DO NOTHING`,
      [s.id, s.orderId, s.artistId, s.amountCents, ts(s.nextAttemptAt), ts(s.createdAt)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async findByOrder(orderId: string): Promise<Settlement | undefined> {
    const res = await this.q.query<SettlementRow>('SELECT * FROM settlements WHERE order_id = $1', [
      orderId,
    ]);
    return res.rows[0] ? toSettlement(res.rows[0]) : undefined;
  }

  async findByOrderForUpdate(orderId: string): Promise<Settlement | undefined> {
    const res = await this.q.query<SettlementRow>(
      'SELECT * FROM settlements WHERE order_id = $1 FOR UPDATE',
      [orderId],
    );
    return res.rows[0] ? toSettlement(res.rows[0]) : undefined;
  }

  async save(s: Settlement): Promise<void> {
    await this.q.query(
      `UPDATE settlements SET
         amount_cents = $2, status = $3, block_reason = $4, transfer_ref = $5, attempts = $6,
         next_attempt_at = $7, released_by = $8, alerted_at = $9, completed_at = $10, updated_at = $11
       WHERE id = $1`,
      [
        s.id,
        s.amountCents,
        s.status,
        s.blockReason ?? null,
        s.transferRef ?? null,
        s.attempts,
        ts(s.nextAttemptAt),
        s.releasedBy ?? null,
        s.alertedAt ? ts(s.alertedAt) : null,
        s.completedAt ? ts(s.completedAt) : null,
        ts(s.updatedAt),
      ],
    );
  }

  async claimDue(now: Instant, limit: number, leaseMs: number): Promise<Settlement[]> {
    const res = await this.q.query<SettlementRow>(
      `UPDATE settlements SET next_attempt_at = $3
        WHERE id IN (
          SELECT id FROM settlements
           WHERE status = 'pendiente' AND next_attempt_at <= $1
           ORDER BY next_attempt_at LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [ts(now), limit, ts((now + leaseMs) as Instant)],
    );
    return res.rows.map(toSettlement);
  }

  async listByArtist(artistId: string, limit: number): Promise<Settlement[]> {
    const res = await this.q.query<SettlementRow>(
      'SELECT * FROM settlements WHERE artist_id = $1 ORDER BY created_at DESC LIMIT $2',
      [artistId, limit],
    );
    return res.rows.map(toSettlement);
  }

  async listBetween(from: Instant, to: Instant): Promise<Settlement[]> {
    const res = await this.q.query<SettlementRow>(
      'SELECT * FROM settlements WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at',
      [ts(from), ts(to)],
    );
    return res.rows.map(toSettlement);
  }

  async listBlockedUnalerted(before: Instant, limit: number): Promise<Settlement[]> {
    const res = await this.q.query<SettlementRow>(
      `SELECT * FROM settlements
        WHERE status = 'pendiente' AND alerted_at IS NULL AND created_at <= $1
        ORDER BY created_at LIMIT $2`,
      [ts(before), limit],
    );
    return res.rows.map(toSettlement);
  }
}

// ---------------------------------------------------------------------------------------------
// Retiradas
// ---------------------------------------------------------------------------------------------
type WithdrawalRow = {
  id: string;
  artist_id: string;
  seq: number;
  amount_cents: number;
  status: WithdrawalStatus;
  payout_ref: string | null;
  idempotency_key: string;
  attempts: number;
  next_attempt_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
};

const toWithdrawal = (r: WithdrawalRow): Withdrawal => ({
  id: r.id,
  artistId: r.artist_id,
  seq: r.seq,
  amountCents: r.amount_cents,
  status: r.status,
  payoutRef: opt(r.payout_ref),
  idempotencyKey: r.idempotency_key,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at ? at(r.next_attempt_at) : undefined,
  createdAt: at(r.created_at),
  completedAt: r.completed_at ? at(r.completed_at) : undefined,
});

export class PgWithdrawalRepository implements WithdrawalRepository {
  constructor(private readonly q: Queryable) {}

  async insert(w: Withdrawal): Promise<void> {
    await this.q.query(
      `INSERT INTO withdrawals
         (id, artist_id, seq, amount_cents, status, idempotency_key, attempts, next_attempt_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        w.id,
        w.artistId,
        w.seq,
        w.amountCents,
        w.status,
        w.idempotencyKey,
        w.attempts,
        w.nextAttemptAt ? ts(w.nextAttemptAt) : null,
        ts(w.createdAt),
      ],
    );
  }

  async findOpenByArtist(artistId: string): Promise<Withdrawal | undefined> {
    const res = await this.q.query<WithdrawalRow>(
      `SELECT * FROM withdrawals WHERE artist_id = $1 AND status = 'solicitada' LIMIT 1`,
      [artistId],
    );
    return res.rows[0] ? toWithdrawal(res.rows[0]) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Withdrawal | undefined> {
    const res = await this.q.query<WithdrawalRow>(
      'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE',
      [id],
    );
    return res.rows[0] ? toWithdrawal(res.rows[0]) : undefined;
  }

  async save(w: Withdrawal): Promise<void> {
    await this.q.query(
      `UPDATE withdrawals SET status = $2, payout_ref = $3, attempts = $4,
              next_attempt_at = $5, completed_at = $6 WHERE id = $1`,
      [
        w.id,
        w.status,
        w.payoutRef ?? null,
        w.attempts,
        w.nextAttemptAt ? ts(w.nextAttemptAt) : null,
        w.completedAt ? ts(w.completedAt) : null,
      ],
    );
  }

  async listByArtist(artistId: string, limit: number): Promise<Withdrawal[]> {
    const res = await this.q.query<WithdrawalRow>(
      'SELECT * FROM withdrawals WHERE artist_id = $1 ORDER BY created_at DESC LIMIT $2',
      [artistId, limit],
    );
    return res.rows.map(toWithdrawal);
  }

  async listBetween(from: Instant, to: Instant): Promise<Withdrawal[]> {
    const res = await this.q.query<WithdrawalRow>(
      'SELECT * FROM withdrawals WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at',
      [ts(from), ts(to)],
    );
    return res.rows.map(toWithdrawal);
  }

  async claimOpenDue(now: Instant, limit: number, leaseMs: number): Promise<Withdrawal[]> {
    const res = await this.q.query<WithdrawalRow>(
      `UPDATE withdrawals SET next_attempt_at = $3
        WHERE id IN (
          SELECT id FROM withdrawals
           WHERE status = 'solicitada' AND next_attempt_at IS NOT NULL AND next_attempt_at <= $1
           ORDER BY next_attempt_at LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [ts(now), limit, ts((now + leaseMs) as Instant)],
    );
    return res.rows.map(toWithdrawal);
  }
}

// ---------------------------------------------------------------------------------------------
// Reembolsos
// ---------------------------------------------------------------------------------------------
type RefundRow = {
  id: string;
  order_id: string;
  seq: number;
  amount_cents: number;
  shipping_part_cents: number;
  artist_part_cents: number;
  status: RefundStatus;
  refund_ref: string | null;
  reason_code: string;
  requested_by: 'operador' | 'sistema';
  created_at: Date;
  completed_at: Date | null;
};

const toRefund = (r: RefundRow): Refund => ({
  id: r.id,
  orderId: r.order_id,
  seq: r.seq,
  amountCents: r.amount_cents,
  shippingPartCents: r.shipping_part_cents,
  artistPartCents: r.artist_part_cents,
  status: r.status,
  refundRef: opt(r.refund_ref),
  reasonCode: r.reason_code,
  requestedBy: r.requested_by,
  createdAt: at(r.created_at),
  completedAt: r.completed_at ? at(r.completed_at) : undefined,
});

export class PgRefundRepository implements RefundRepository {
  constructor(private readonly q: Queryable) {}

  async insert(r: Refund): Promise<void> {
    await this.q.query(
      `INSERT INTO refunds
         (id, order_id, seq, amount_cents, shipping_part_cents, artist_part_cents, status,
          reason_code, requested_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        r.id,
        r.orderId,
        r.seq,
        r.amountCents,
        r.shippingPartCents,
        r.artistPartCents,
        r.status,
        r.reasonCode,
        r.requestedBy,
        ts(r.createdAt),
      ],
    );
  }

  async listByOrder(orderId: string): Promise<Refund[]> {
    const res = await this.q.query<RefundRow>(
      'SELECT * FROM refunds WHERE order_id = $1 ORDER BY seq',
      [orderId],
    );
    return res.rows.map(toRefund);
  }

  async findByIdForUpdate(id: string): Promise<Refund | undefined> {
    const res = await this.q.query<RefundRow>('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [
      id,
    ]);
    return res.rows[0] ? toRefund(res.rows[0]) : undefined;
  }

  async save(r: Refund): Promise<void> {
    await this.q.query(
      'UPDATE refunds SET status = $2, refund_ref = $3, completed_at = $4 WHERE id = $1',
      [r.id, r.status, r.refundRef ?? null, r.completedAt ? ts(r.completedAt) : null],
    );
  }

  async listBetween(from: Instant, to: Instant): Promise<Refund[]> {
    const res = await this.q.query<RefundRow>(
      'SELECT * FROM refunds WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at',
      [ts(from), ts(to)],
    );
    return res.rows.map(toRefund);
  }
}
