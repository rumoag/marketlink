import { instantOf, type Instant } from '@/modules/kernel/domain/clock';
import type { Queryable } from '@/modules/platform/infrastructure/pg-runner';
import {
  SubmissionKeyTakenError,
  type ArtistContactRepository,
  type OrderEventStore,
  type OrderRepository,
} from '../application/ports';
import {
  SWEEP_GRACE_MS,
  type Buyer,
  type Consent,
  type Destination,
  type Modality,
  type Order,
  type OrderEvent,
  type OrderSnapshot,
  type OrderStatus,
  type PaymentMode,
  type QuoteRef,
  type RefundStatus,
  type SenderSnapshot,
} from '../domain/order';

const at = (d: Date): Instant => instantOf(d.getTime());
const ts = (t: Instant): Date => new Date(t);

type OrderRow = {
  id: string;
  listing_id: string;
  artist_id: string;
  status: OrderStatus;
  version: number;
  payment_mode: PaymentMode;
  snapshot: OrderSnapshot;
  sender_address: SenderSnapshot;
  buyer: Buyer | null;
  destination: Destination | null;
  effective_modality: Modality;
  alternative_accepted: boolean;
  work_price_cents: number;
  shipping_cents: number;
  total_cents: number;
  quote: QuoteRef;
  consent: { privacyVersion: string; termsVersion: string; acceptedAt: number };
  checkout_session_id: string | null;
  payment_intent_id: string | null;
  reservation_id: string | null;
  tracking_nonce: string;
  tracking_hash: string;
  token_key_id: string;
  resume_hash: string | null;
  resume_expires_at: Date | null;
  submission_key: string;
  expires_at: Date;
  refund_status: RefundStatus;
  refund_reason: string | null;
  refund_id: string | null;
  personal_purged_at: Date | null;
  label_cost_cents: number | null;
  margin_cents: number | null;
  charge_id: string | null;
  payment_method: 'tarjeta' | 'bizum' | null;
  created_at: Date;
  updated_at: Date;
};

const toOrder = (r: OrderRow): Order => ({
  id: r.id,
  listingId: r.listing_id,
  artistId: r.artist_id,
  status: r.status,
  version: r.version,
  paymentMode: r.payment_mode,
  snapshot: r.snapshot,
  sender: r.sender_address,
  buyer: r.buyer ?? undefined,
  destination: r.destination ?? undefined,
  effectiveModality: r.effective_modality,
  alternativeAccepted: r.alternative_accepted,
  workPriceCents: r.work_price_cents,
  shippingCents: r.shipping_cents,
  totalCents: r.total_cents,
  commissionCents: 0,
  quote: r.quote,
  consent: {
    privacyVersion: r.consent.privacyVersion,
    termsVersion: r.consent.termsVersion,
    acceptedAt: instantOf(r.consent.acceptedAt),
  } satisfies Consent,
  checkoutSessionId: r.checkout_session_id ?? undefined,
  paymentIntentId: r.payment_intent_id ?? undefined,
  reservationId: r.reservation_id ?? undefined,
  trackingNonce: r.tracking_nonce,
  trackingHash: r.tracking_hash,
  tokenKeyId: r.token_key_id,
  resumeHash: r.resume_hash ?? undefined,
  resumeExpiresAt: r.resume_expires_at ? at(r.resume_expires_at) : undefined,
  submissionKey: r.submission_key,
  expiresAt: at(r.expires_at),
  refundStatus: r.refund_status,
  refundReason: r.refund_reason ?? undefined,
  refundId: r.refund_id ?? undefined,
  personalPurgedAt: r.personal_purged_at ? at(r.personal_purged_at) : undefined,
  labelCostCents: r.label_cost_cents ?? undefined,
  marginCents: r.margin_cents ?? undefined,
  chargeId: r.charge_id ?? undefined,
  paymentMethod: r.payment_method ?? undefined,
  createdAt: at(r.created_at),
  updatedAt: at(r.updated_at),
});

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

const isSubmissionKeyConflict = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === '23505' &&
  (e as { constraint?: string }).constraint === 'orders_submission_key_key';

export class PgOrderRepository implements OrderRepository {
  constructor(private readonly q: Queryable) {}

  async insert(o: Order): Promise<void> {
    try {
      await this.q.query(
        `INSERT INTO orders
           (id, listing_id, artist_id, status, version, payment_mode, snapshot, sender_address,
            buyer, destination, effective_modality, alternative_accepted, work_price_cents,
            shipping_cents, total_cents, commission_cents, quote, consent, checkout_session_id,
            payment_intent_id, reservation_id, tracking_nonce, tracking_hash, token_key_id,
            resume_hash, resume_expires_at, submission_key, expires_at, refund_status,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,0,
                 $16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$29)`,
        [
          o.id,
          o.listingId,
          o.artistId,
          o.status,
          o.version,
          o.paymentMode,
          json(o.snapshot),
          json(o.sender),
          json(o.buyer),
          json(o.destination),
          o.effectiveModality,
          o.alternativeAccepted,
          o.workPriceCents,
          o.shippingCents,
          o.totalCents,
          json(o.quote),
          json({ ...o.consent }),
          o.checkoutSessionId ?? null,
          o.paymentIntentId ?? null,
          o.reservationId ?? null,
          o.trackingNonce,
          o.trackingHash,
          o.tokenKeyId,
          o.resumeHash ?? null,
          o.resumeExpiresAt ? ts(o.resumeExpiresAt) : null,
          o.submissionKey,
          ts(o.expiresAt),
          o.refundStatus,
          ts(o.createdAt),
        ],
      );
    } catch (e) {
      if (isSubmissionKeyConflict(e)) throw new SubmissionKeyTakenError();
      throw e;
    }
  }

  private async one(sql: string, params: unknown[]): Promise<Order | undefined> {
    const res = await this.q.query<OrderRow>(sql, params);
    return res.rows[0] ? toOrder(res.rows[0]) : undefined;
  }

  findById(id: string): Promise<Order | undefined> {
    return this.one('SELECT * FROM orders WHERE id = $1', [id]);
  }
  findByIdForUpdate(id: string): Promise<Order | undefined> {
    return this.one('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
  }
  findBySubmissionKey(key: string): Promise<Order | undefined> {
    return this.one('SELECT * FROM orders WHERE submission_key = $1', [key]);
  }
  findByCheckoutSession(sessionId: string): Promise<Order | undefined> {
    return this.one('SELECT * FROM orders WHERE checkout_session_id = $1', [sessionId]);
  }
  findByTrackingHash(hash: string): Promise<Order | undefined> {
    return this.one('SELECT * FROM orders WHERE tracking_hash = $1', [hash]);
  }
  findByResumeHash(hash: string): Promise<Order | undefined> {
    return this.one('SELECT * FROM orders WHERE resume_hash = $1', [hash]);
  }

  async save(o: Order): Promise<boolean> {
    const res = await this.q.query(
      `UPDATE orders SET
         status = $3, version = $2, payment_intent_id = $4, checkout_session_id = $5,
         reservation_id = $6, resume_hash = $7, resume_expires_at = $8, refund_status = $9,
         refund_reason = $10, refund_id = $11, buyer = $12::jsonb, destination = $13::jsonb,
         personal_purged_at = $14, updated_at = $15, label_cost_cents = $16, margin_cents = $17,
         charge_id = $18, payment_method = $19
       WHERE id = $1 AND version = $2 - 1`,
      [
        o.id,
        o.version,
        o.status,
        o.paymentIntentId ?? null,
        o.checkoutSessionId ?? null,
        o.reservationId ?? null,
        o.resumeHash ?? null,
        o.resumeExpiresAt ? ts(o.resumeExpiresAt) : null,
        o.refundStatus,
        o.refundReason ?? null,
        o.refundId ?? null,
        json(o.buyer),
        json(o.destination),
        o.personalPurgedAt ? ts(o.personalPurgedAt) : null,
        ts(o.updatedAt),
        o.labelCostCents ?? null,
        o.marginCents ?? null,
        o.chargeId ?? null,
        o.paymentMethod ?? null,
      ],
    );
    return res.rowCount === 1;
  }

  async listByArtist(artistId: string, limit: number): Promise<Order[]> {
    const res = await this.q.query<OrderRow>(
      'SELECT * FROM orders WHERE artist_id = $1 ORDER BY created_at DESC LIMIT $2',
      [artistId, limit],
    );
    return res.rows.map(toOrder);
  }

  async listOverdue(now: Instant, limit: number): Promise<Order[]> {
    const res = await this.q.query<OrderRow>(
      `SELECT * FROM orders
        WHERE status = 'pendiente_pago' AND expires_at <= $1
        ORDER BY expires_at LIMIT $2`,
      [ts(instantOf(now - SWEEP_GRACE_MS)), limit],
    );
    return res.rows.map(toOrder);
  }

  async listPurgeable(before: Instant, limit: number): Promise<Order[]> {
    const res = await this.q.query<OrderRow>(
      `SELECT * FROM orders
        WHERE status IN ('expirado', 'cancelado') AND personal_purged_at IS NULL
          AND updated_at < $1
        ORDER BY updated_at LIMIT $2`,
      [ts(before), limit],
    );
    return res.rows.map(toOrder);
  }

  findByPaymentIntent(paymentIntentId: string): Promise<Order | undefined> {
    return this.one('SELECT * FROM orders WHERE payment_intent_id = $1', [paymentIntentId]);
  }

  async listStaleInTransit(before: Instant, limit: number): Promise<Order[]> {
    const res = await this.q.query<OrderRow>(
      `SELECT * FROM orders WHERE status = 'en_transito' AND updated_at <= $1
        ORDER BY updated_at LIMIT $2`,
      [ts(before), limit],
    );
    return res.rows.map(toOrder);
  }

  async listPaidBetween(from: Instant, to: Instant, limit: number): Promise<Order[]> {
    const res = await this.q.query<OrderRow>(
      `SELECT * FROM orders
        WHERE payment_mode = 'stripe' AND created_at >= $1 AND created_at < $2
          AND status IN ('pagado', 'error_borrador', 'borrador_creado', 'etiqueta_lista',
                         'en_transito', 'entregado', 'liquidado')
        ORDER BY created_at LIMIT $3`,
      [ts(from), ts(to), limit],
    );
    return res.rows.map(toOrder);
  }

  async listStripeSince(since: Instant, limit: number): Promise<Order[]> {
    const res = await this.q.query<OrderRow>(
      `SELECT * FROM orders
        WHERE payment_mode = 'stripe' AND created_at >= $1
        ORDER BY created_at DESC LIMIT $2`,
      [ts(since), limit],
    );
    return res.rows.map(toOrder);
  }
}

type EventRow = {
  order_id: string;
  artist_id: string;
  at: Date;
  actor: OrderEvent['actor'];
  kind: OrderEvent['kind'];
  from_status: OrderStatus;
  to_status: OrderStatus;
  reason_code: string | null;
  external_ref: string | null;
};

export class PgOrderEventStore implements OrderEventStore {
  constructor(private readonly q: Queryable) {}

  async append(e: OrderEvent): Promise<void> {
    await this.q.query(
      `INSERT INTO order_events
         (order_id, artist_id, at, actor, kind, from_status, to_status, reason_code, external_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        e.orderId,
        e.artistId,
        ts(e.at),
        e.actor,
        e.kind,
        e.fromStatus,
        e.toStatus,
        e.reasonCode ?? null,
        e.externalRef ?? null,
      ],
    );
  }

  async listByOrder(orderId: string): Promise<OrderEvent[]> {
    const res = await this.q.query<EventRow>(
      'SELECT * FROM order_events WHERE order_id = $1 ORDER BY at, id',
      [orderId],
    );
    return res.rows.map((r) => ({
      orderId: r.order_id,
      artistId: r.artist_id,
      at: at(r.at),
      actor: r.actor,
      kind: r.kind,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reasonCode: r.reason_code ?? undefined,
      externalRef: r.external_ref ?? undefined,
    }));
  }
}

export class PgArtistContactRepository implements ArtistContactRepository {
  constructor(private readonly q: Queryable) {}

  async findBizumPhone(artistId: string): Promise<string | undefined> {
    const res = await this.q.query<{ bizum_phone: string | null }>(
      'SELECT bizum_phone FROM artists WHERE id = $1',
      [artistId],
    );
    return res.rows[0]?.bizum_phone ?? undefined;
  }

  async findEmail(artistId: string): Promise<string | undefined> {
    const res = await this.q.query<{ email: string }>('SELECT email FROM artists WHERE id = $1', [
      artistId,
    ]);
    return res.rows[0]?.email;
  }

  async saveBizumPhone(artistId: string, phone: string | undefined, now: Instant): Promise<void> {
    await this.q.query('UPDATE artists SET bizum_phone = $2, updated_at = $3 WHERE id = $1', [
      artistId,
      phone ?? null,
      ts(now),
    ]);
  }
}
