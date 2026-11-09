import { instantOf, type Instant } from '@/modules/kernel/domain/clock';
import type { Queryable } from '@/modules/platform/infrastructure/pg-runner';
import type { NotificationRepository } from '../application/ports';
import type {
  Notification,
  NotificationStatus,
  NotificationType,
  RecipientRole,
} from '../domain/notification';

const at = (d: Date): Instant => instantOf(d.getTime());
const ts = (t: Instant): Date => new Date(t);

type Row = {
  id: string;
  order_id: string | null;
  dedupe_ref: string | null;
  amount_cents: number | null;
  artist_id: string;
  type: NotificationType;
  recipient_role: RecipientRole;
  status: NotificationStatus;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  sent_at: Date | null;
};

const toNotification = (r: Row): Notification => ({
  id: r.id,
  orderId: r.order_id ?? undefined,
  dedupeRef: r.dedupe_ref ?? undefined,
  amountCents: r.amount_cents ?? undefined,
  artistId: r.artist_id,
  type: r.type,
  recipientRole: r.recipient_role,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: at(r.next_attempt_at),
  lastError: r.last_error ?? undefined,
  createdAt: at(r.created_at),
  sentAt: r.sent_at ? at(r.sent_at) : undefined,
});

export class PgNotificationRepository implements NotificationRepository {
  constructor(private readonly q: Queryable) {}

  async insertMany(notifications: readonly Notification[]): Promise<number> {
    let inserted = 0;
    for (const n of notifications) {
      const conflict =
        n.orderId !== undefined
          ? 'ON CONFLICT (order_id, type) DO NOTHING'
          : 'ON CONFLICT (type, dedupe_ref) WHERE dedupe_ref IS NOT NULL DO NOTHING';
      const res = await this.q.query(
        `INSERT INTO notifications
           (id, order_id, dedupe_ref, amount_cents, artist_id, type, recipient_role, status,
            attempts, next_attempt_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendiente', 0, $8, $9)
         ${conflict}`,
        [
          n.id,
          n.orderId ?? null,
          n.dedupeRef ?? null,
          n.amountCents ?? null,
          n.artistId,
          n.type,
          n.recipientRole,
          ts(n.nextAttemptAt),
          ts(n.createdAt),
        ],
      );
      inserted += res.rowCount ?? 0;
    }
    return inserted;
  }

  async claimDue(now: Instant, limit: number, leaseMs: number): Promise<Notification[]> {
    const res = await this.q.query<Row>(
      `UPDATE notifications SET next_attempt_at = $3
        WHERE id IN (
          SELECT id FROM notifications
           WHERE status = 'pendiente' AND next_attempt_at <= $1
           ORDER BY next_attempt_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [ts(now), limit, ts(((now as number) + leaseMs) as Instant)],
    );
    return res.rows.map(toNotification);
  }

  async markSent(id: string, now: Instant): Promise<void> {
    await this.q.query(
      `UPDATE notifications SET status = 'enviada', sent_at = $2, last_error = NULL WHERE id = $1`,
      [id, ts(now)],
    );
  }

  async reschedule(
    id: string,
    attempts: number,
    nextAttemptAt: Instant,
    error: string,
  ): Promise<void> {
    await this.q.query(
      `UPDATE notifications SET attempts = $2, next_attempt_at = $3, last_error = $4 WHERE id = $1`,
      [id, attempts, ts(nextAttemptAt), error.slice(0, 60)],
    );
  }

  async markFailed(id: string, attempts: number, error: string): Promise<void> {
    await this.q.query(
      `UPDATE notifications SET status = 'fallida', attempts = $2, last_error = $3 WHERE id = $1`,
      [id, attempts, error.slice(0, 60)],
    );
  }

  async listFailedByArtist(artistId: string): Promise<Notification[]> {
    const res = await this.q.query<Row>(
      `SELECT * FROM notifications WHERE artist_id = $1 AND status = 'fallida'
        ORDER BY created_at DESC LIMIT 20`,
      [artistId],
    );
    return res.rows.map(toNotification);
  }

  async deleteOlderThan(before: Instant): Promise<number> {
    const res = await this.q.query('DELETE FROM notifications WHERE created_at < $1', [ts(before)]);
    return res.rowCount ?? 0;
  }
}
