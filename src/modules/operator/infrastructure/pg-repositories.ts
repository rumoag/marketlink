import type { Queryable } from '@/modules/platform/infrastructure/pg-runner';
import type { ManualFlagReader } from '@/modules/payouts/application/ports';
import type { OrderStatus } from '@/modules/orders/domain/order';
import type { RawMetrics } from '../domain/settings-and-metrics';
import { DRAFT_UNPAID_MS, PICKUP_UNCHOSEN_MS } from '../domain/stuck';
import type {
  BackupRun,
  DraftRow,
  EmailStats,
  JobStats,
  PurgeCandidate,
  OperatorNote,
  OperatorRepository,
  OrderFilter,
  OrderFlag,
  OrderRow,
  SizeValues,
  TotpState,
} from '../application/ports';

const ms = (d: Date | null): number | undefined => (d ? d.getTime() : undefined);
const ts = (t: number): Date => new Date(t);

type TotpRow = {
  email: string;
  last_step: string;
  failures: number;
  window_start: Date | null;
  locked_until: Date | null;
};
const toTotp = (r: TotpRow): TotpState => ({
  email: r.email,
  lastStep: Number(r.last_step),
  failures: r.failures,
  windowStart: ms(r.window_start),
  lockedUntil: ms(r.locked_until),
});

type FlagRow = {
  id: string;
  order_id: string;
  reason: string;
  opened_by: string;
  opened_at: Date;
  resolution: string | null;
  closed_by: string | null;
  closed_at: Date | null;
};
const toFlag = (r: FlagRow): OrderFlag => ({
  id: r.id,
  orderId: r.order_id,
  reason: r.reason,
  openedBy: r.opened_by,
  openedAt: r.opened_at.getTime(),
  resolution: r.resolution ?? undefined,
  closedBy: r.closed_by ?? undefined,
  closedAt: ms(r.closed_at),
});

type ListRow = {
  id: string;
  created_at: Date;
  status: OrderStatus;
  updated_at: Date;
  artist_id: string;
  artist_name: string;
  title: string;
  total_cents: number;
  provider_ref: string | null;
  ship_status: OrderRow['shipmentStatus'] | null;
  draft_created_at: Date | null;
  pickup_chosen: boolean | null;
  pickup_requested_at: Date | null;
  flag_open: boolean;
  settlement_blocked: boolean | null;
};

const toRow = (r: ListRow): OrderRow => ({
  id: r.id,
  createdAt: r.created_at.getTime(),
  status: r.status,
  updatedAt: r.updated_at.getTime(),
  artistId: r.artist_id,
  artistName: r.artist_name,
  title: r.title,
  totalCents: r.total_cents,
  providerRef: r.provider_ref ?? undefined,
  shipmentStatus: r.ship_status ?? undefined,
  draftCreatedAt: ms(r.draft_created_at),
  pickupChosen: r.pickup_chosen ?? false,
  pickupRequestedAt: ms(r.pickup_requested_at),
  manualFlagOpen: r.flag_open,
  settlementBlocked: r.settlement_blocked === true,
});

const FROM = `
  FROM orders o
  JOIN artists a ON a.id = o.artist_id
  LEFT JOIN shipments s ON s.order_id = o.id
  LEFT JOIN settlements st ON st.order_id = o.id`;

const FLAG_OPEN = `EXISTS (SELECT 1 FROM order_flags f WHERE f.order_id = o.id AND f.closed_at IS NULL)`;

/**
 * Misma regla que `stuckReason` (dominio), expresada en SQL. Una propiedad de integración
 * comprueba que ambas coinciden (P-U6-08).
 */
const stuckSql = (nowParam: string, staleParam: string): string => `(
  ${FLAG_OPEN}
  OR o.status = 'error_borrador'
  OR (s.status = 'borrador' AND s.draft_created_at IS NOT NULL
      AND s.draft_created_at <= ${nowParam}::timestamptz - interval '${DRAFT_UNPAID_MS} milliseconds')
  OR (s.status = 'creando' AND s.pickup IS NULL AND s.pickup_requested_at IS NOT NULL
      AND s.pickup_requested_at <= ${nowParam}::timestamptz - interval '${PICKUP_UNCHOSEN_MS} milliseconds')
  OR (o.status = 'en_transito'
      AND o.updated_at <= ${nowParam}::timestamptz - (${staleParam}::int * interval '1 day'))
  OR (st.status = 'pendiente' AND st.block_reason IS NOT NULL))`;

const whereOf = (
  filter: OrderFilter,
  now: number,
  staleDays: number,
): { sql: string; params: unknown[] } => {
  const params: unknown[] = [];
  const parts: string[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filter.status) parts.push(`o.status = ${add(filter.status)}`);
  if (filter.artistId) parts.push(`o.artist_id = ${add(filter.artistId)}`);
  if (filter.from !== undefined) parts.push(`o.created_at >= ${add(ts(filter.from))}`);
  if (filter.to !== undefined) parts.push(`o.created_at < ${add(ts(filter.to))}`);
  if (filter.stuckOnly) parts.push(stuckSql(add(ts(now)), add(staleDays)));
  return { sql: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', params };
};

export class PgOperatorRepository implements OperatorRepository {
  constructor(private readonly q: Queryable) {}

  // --- U7: limpieza, alertas y salud -------------------------------------------------------
  async listPurgeCandidates(now: number, months: number, limit: number): Promise<PurgeCandidate[]> {
    // Prefiltro generoso (+2 dias): el servicio recalcula con la funcion pura de dominio.
    const res = await this.q.query<{ id: string }>(
      `SELECT o.id
         FROM orders o LEFT JOIN shipments s ON s.order_id = o.id
        WHERE o.personal_purged_at IS NULL
          AND (o.buyer IS NOT NULL OR o.destination IS NOT NULL)
          AND o.status NOT IN ('pendiente_pago', 'expirado', 'cancelado')
          AND COALESCE(
                s.delivered_at,
                (SELECT min(e.at) FROM order_events e
                  WHERE e.order_id = o.id AND e.kind IN ('pago_confirmado', 'cobro_manual_confirmado')),
                o.created_at)
              <= $1::timestamptz - ($2::int * interval '1 month') + interval '2 days'
        ORDER BY o.created_at LIMIT $3`,
      [ts(now), months, limit],
    );
    return res.rows.map((r) => ({ orderId: r.id }));
  }

  async securityCounts(since: number) {
    const res = await this.q.query<{ a: string; b: string; c: string; d: string }>(
      `SELECT count(*) FILTER (WHERE action = 'auth_failure')::text AS a,
              count(*) FILTER (WHERE action = 'authz_denied')::text AS b,
              count(*) FILTER (WHERE action = 'webhook_signature_invalid')::text AS c,
              count(*) FILTER (WHERE action = 'operator_locked')::text AS d
         FROM audit_events
        WHERE occurred_at >= $1
          AND action IN ('auth_failure', 'authz_denied', 'webhook_signature_invalid', 'operator_locked')`,
      [ts(since)],
    );
    const r = res.rows[0];
    return {
      authFailures: Number(r?.a ?? 0),
      authzDenied: Number(r?.b ?? 0),
      webhookSignatures: Number(r?.c ?? 0),
      operatorLocked: Number(r?.d ?? 0),
    };
  }

  async hasAlertInBucket(code: string, bucket: string): Promise<boolean> {
    const res = await this.q.query(
      `SELECT 1 FROM audit_events
        WHERE action = 'operator_alert' AND resource_id = $1 AND details->>'detail' = $2
        LIMIT 1`,
      [code, bucket],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async auditRows(): Promise<number> {
    const res = await this.q.query<{ n: string }>(
      `SELECT reltuples::bigint::text AS n FROM pg_class WHERE oid = 'public.audit_events'::regclass`,
    );
    return Math.max(0, Number(res.rows[0]?.n ?? 0));
  }

  async jobStats(now: number): Promise<JobStats> {
    const res = await this.q.query<{ failed: string; pending: string; running: string }>(
      `SELECT count(*) FILTER (WHERE status = 'failed' AND updated_at >= $1)::text AS failed,
              count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*) FILTER (WHERE status = 'running')::text AS running
         FROM jobs`,
      [ts(now - 24 * 3_600_000)],
    );
    const r = res.rows[0];
    return {
      failed24h: Number(r?.failed ?? 0),
      pending: Number(r?.pending ?? 0),
      running: Number(r?.running ?? 0),
    };
  }

  async emailStats(): Promise<EmailStats> {
    const res = await this.q.query<{ pending: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE status = 'pendiente')::text AS pending,
              count(*) FILTER (WHERE status = 'fallida')::text AS failed
         FROM notifications`,
    );
    return {
      pending: Number(res.rows[0]?.pending ?? 0),
      failed: Number(res.rows[0]?.failed ?? 0),
    };
  }

  async alertStats(since: number): Promise<{ code: string; n: number }[]> {
    const res = await this.q.query<{ code: string; n: string }>(
      `SELECT resource_id AS code, count(*)::text AS n FROM audit_events
        WHERE action = 'operator_alert' AND occurred_at >= $1
        GROUP BY resource_id ORDER BY count(*) DESC`,
      [ts(since)],
    );
    return res.rows.map((r) => ({ code: r.code, n: Number(r.n) }));
  }

  async blockedSettlements(): Promise<number> {
    const res = await this.q.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM settlements WHERE status = 'pendiente' AND block_reason IS NOT NULL`,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async lastBackup(): Promise<BackupRun | undefined> {
    const res = await this.q.query<{ at: Date; size_bytes: string }>(
      'SELECT at, size_bytes::text FROM backup_runs ORDER BY at DESC LIMIT 1',
    );
    const r = res.rows[0];
    return r ? { at: r.at.getTime(), sizeBytes: Number(r.size_bytes) } : undefined;
  }

  async dbPing(): Promise<boolean> {
    const res = await this.q.query('SELECT 1');
    return (res.rowCount ?? 0) === 1;
  }

  // --- Segundo factor ----------------------------------------------------------------------
  async getTotpState(email: string): Promise<TotpState | undefined> {
    const res = await this.q.query<TotpRow>('SELECT * FROM operator_totp_state WHERE email = $1', [
      email,
    ]);
    return res.rows[0] ? toTotp(res.rows[0]) : undefined;
  }

  async acceptStep(email: string, step: number, now: number): Promise<boolean> {
    // Una sola sentencia: solo gana quien sube el paso (dos peticiones con el mismo codigo, una).
    const res = await this.q.query(
      `INSERT INTO operator_totp_state AS s (email, last_step, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
         SET last_step = EXCLUDED.last_step, updated_at = EXCLUDED.updated_at
         WHERE s.last_step < EXCLUDED.last_step`,
      [email, step, ts(now)],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async recordFailure(
    email: string,
    now: number,
    windowMs: number,
    max: number,
    lockMs: number,
  ): Promise<TotpState> {
    const res = await this.q.query<TotpRow>(
      `INSERT INTO operator_totp_state AS s (email, failures, window_start, updated_at)
       VALUES ($1, 1, $2, $2)
       ON CONFLICT (email) DO UPDATE SET
         failures = CASE WHEN s.window_start IS NULL
                           OR s.window_start < $2::timestamptz - ($3::int * interval '1 millisecond')
                         THEN 1 ELSE s.failures + 1 END,
         window_start = CASE WHEN s.window_start IS NULL
                               OR s.window_start < $2::timestamptz - ($3::int * interval '1 millisecond')
                             THEN $2 ELSE s.window_start END,
         locked_until = CASE WHEN (CASE WHEN s.window_start IS NULL
                                          OR s.window_start < $2::timestamptz - ($3::int * interval '1 millisecond')
                                        THEN 1 ELSE s.failures + 1 END) >= $4
                             THEN $2::timestamptz + ($5::int * interval '1 millisecond')
                             ELSE s.locked_until END,
         updated_at = $2
       RETURNING *`,
      [email, ts(now), windowMs, max, lockMs],
    );
    return toTotp(res.rows[0] as TotpRow);
  }

  async resetFailures(email: string, now: number): Promise<void> {
    await this.q.query(
      `UPDATE operator_totp_state
          SET failures = 0, window_start = NULL, locked_until = NULL, updated_at = $2
        WHERE email = $1`,
      [email, ts(now)],
    );
  }

  // --- Incidencias y notas -----------------------------------------------------------------
  async findOpenFlag(orderId: string): Promise<OrderFlag | undefined> {
    const res = await this.q.query<FlagRow>(
      'SELECT * FROM order_flags WHERE order_id = $1 AND closed_at IS NULL',
      [orderId],
    );
    return res.rows[0] ? toFlag(res.rows[0]) : undefined;
  }

  async listFlags(orderId: string): Promise<OrderFlag[]> {
    const res = await this.q.query<FlagRow>(
      'SELECT * FROM order_flags WHERE order_id = $1 ORDER BY opened_at DESC',
      [orderId],
    );
    return res.rows.map(toFlag);
  }

  async openFlag(f: OrderFlag): Promise<boolean> {
    const res = await this.q.query(
      `INSERT INTO order_flags (id, order_id, reason, opened_by, opened_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_id) WHERE closed_at IS NULL DO NOTHING`,
      [f.id, f.orderId, f.reason, f.openedBy, ts(f.openedAt)],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async closeFlag(id: string, closedBy: string, resolution: string, now: number): Promise<boolean> {
    const res = await this.q.query(
      `UPDATE order_flags SET resolution = $3, closed_by = $2, closed_at = $4
        WHERE id = $1 AND closed_at IS NULL`,
      [id, closedBy, resolution, ts(now)],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async addNote(n: OperatorNote): Promise<boolean> {
    const res = await this.q.query(
      `INSERT INTO operator_notes (id, order_id, author, at, text, form_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (form_key) DO NOTHING`,
      [n.id, n.orderId, n.author, ts(n.at), n.text, n.formKey ?? null],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async listNotes(orderId: string): Promise<OperatorNote[]> {
    const res = await this.q.query<{
      id: string;
      order_id: string;
      author: string;
      at: Date;
      text: string;
      form_key: string | null;
    }>('SELECT * FROM operator_notes WHERE order_id = $1 ORDER BY at DESC', [orderId]);
    return res.rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      author: r.author,
      at: r.at.getTime(),
      text: r.text,
      formKey: r.form_key ?? undefined,
    }));
  }

  // --- Listas ------------------------------------------------------------------------------
  async listOrders(
    filter: OrderFilter,
    limit: number,
    offset: number,
    now: number,
    staleDays: number,
  ): Promise<{ rows: OrderRow[]; total: number }> {
    const where = whereOf(filter, now, staleDays);
    const total = await this.q.query<{ n: string }>(
      `SELECT count(*)::text AS n ${FROM} ${where.sql}`,
      where.params,
    );
    const p = where.params.length;
    const res = await this.q.query<ListRow>(
      `SELECT o.id, o.created_at, o.status, o.updated_at, o.artist_id,
              COALESCE(a.artistic_name, 'Sin nombre') AS artist_name,
              o.snapshot->>'title' AS title, o.total_cents,
              s.provider_ref, s.status AS ship_status, s.draft_created_at,
              (s.pickup IS NOT NULL) AS pickup_chosen, s.pickup_requested_at,
              ${FLAG_OPEN} AS flag_open,
              (st.status = 'pendiente' AND st.block_reason IS NOT NULL) AS settlement_blocked
       ${FROM} ${where.sql}
       ORDER BY o.created_at DESC, o.id
       LIMIT $${p + 1} OFFSET $${p + 2}`,
      [...where.params, limit, offset],
    );
    return { rows: res.rows.map(toRow), total: Number(total.rows[0]?.n ?? 0) };
  }

  async listDrafts(limit: number): Promise<DraftRow[]> {
    const res = await this.q.query<{
      order_id: string;
      provider_ref: string | null;
      draft_created_at: Date;
      title: string;
    }>(
      `SELECT s.order_id, s.provider_ref, s.draft_created_at, o.snapshot->>'title' AS title
         FROM shipments s JOIN orders o ON o.id = s.order_id
        WHERE s.status = 'borrador' AND s.draft_created_at IS NOT NULL
        ORDER BY s.draft_created_at LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      orderId: r.order_id,
      providerRef: r.provider_ref ?? undefined,
      draftCreatedAt: r.draft_created_at.getTime(),
      title: r.title,
    }));
  }

  async counts(
    now: number,
    staleDays: number,
  ): Promise<{ stuck: number; unpaidDrafts: number; openFlags: number }> {
    const where = whereOf({ stuckOnly: true }, now, staleDays);
    const [stuck, drafts, flags] = await Promise.all([
      this.q.query<{ n: string }>(`SELECT count(*)::text AS n ${FROM} ${where.sql}`, where.params),
      this.q.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM shipments WHERE status = 'borrador'`,
      ),
      this.q.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM order_flags WHERE closed_at IS NULL',
      ),
    ]);
    return {
      stuck: Number(stuck.rows[0]?.n ?? 0),
      unpaidDrafts: Number(drafts.rows[0]?.n ?? 0),
      openFlags: Number(flags.rows[0]?.n ?? 0),
    };
  }

  async listArtists(): Promise<{ id: string; name: string }[]> {
    const res = await this.q.query<{ id: string; name: string }>(
      `SELECT id, COALESCE(artistic_name, 'Sin nombre') AS name FROM artists ORDER BY name LIMIT 200`,
    );
    return res.rows;
  }

  // --- Tamaños -----------------------------------------------------------------------------
  async saveSize(size: 'S' | 'M' | 'L', v: SizeValues, now: number): Promise<boolean> {
    const res = await this.q.query(
      `UPDATE size_presets
          SET length_cm = $2, width_cm = $3, height_cm = $4, weight_kg = $5, updated_at = $6
        WHERE size = $1`,
      [size, v.lengthCm, v.widthCm, v.heightCm, v.weightKg, ts(now)],
    );
    return (res.rowCount ?? 0) === 1;
  }

  // --- Visitas y métricas ------------------------------------------------------------------
  async addView(slug: string, day: string): Promise<boolean> {
    const res = await this.q.query(
      `INSERT INTO listing_views (listing_id, day, count)
       SELECT id, $2::date, 1 FROM listings WHERE slug = $1
       ON CONFLICT (listing_id, day) DO UPDATE SET count = listing_views.count + 1`,
      [slug.toLowerCase(), day],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async purgeViews(beforeDay: string): Promise<number> {
    const res = await this.q.query('DELETE FROM listing_views WHERE day < $1::date', [beforeDay]);
    return res.rowCount ?? 0;
  }

  async rawMetrics(from: number, to: number): Promise<RawMetrics> {
    const f = ts(from);
    const t = ts(to);
    // Pedidos pagados en el periodo: los que tienen el evento de pago dentro del intervalo.
    const paid = `(SELECT DISTINCT order_id FROM order_events
                    WHERE kind IN ('pago_confirmado', 'cobro_manual_confirmado')
                      AND at >= $1 AND at < $2)`;
    const [listings, views, orders, labels, timing, incidents, artists] = await Promise.all([
      this.q.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM listings WHERE created_at >= $1 AND created_at < $2',
        [f, t],
      ),
      this.q.query<{ n: string | null }>(
        `SELECT sum(count)::text AS n FROM listing_views
          WHERE day >= ($1::timestamptz AT TIME ZONE 'UTC')::date
            AND day < ($2::timestamptz AT TIME ZONE 'UTC')::date`,
        [f, t],
      ),
      this.q.query<{
        paid: string;
        card: string;
        bizum: string;
        punto: string;
        recogida: string;
        shipping: string | null;
      }>(
        `SELECT count(*)::text AS paid,
                count(*) FILTER (WHERE o.payment_method = 'tarjeta')::text AS card,
                count(*) FILTER (WHERE o.payment_method = 'bizum')::text AS bizum,
                count(*) FILTER (WHERE o.effective_modality = 'punto')::text AS punto,
                count(*) FILTER (WHERE o.effective_modality = 'recogida')::text AS recogida,
                sum(o.shipping_cents)::text AS shipping
           FROM orders o WHERE o.id IN ${paid}`,
        [f, t],
      ),
      this.q.query<{ cost: string | null; n: string }>(
        `SELECT sum(o.label_cost_cents)::text AS cost, count(*)::text AS n
           FROM orders o WHERE o.id IN ${paid} AND o.label_cost_cents IS NOT NULL`,
        [f, t],
      ),
      this.q.query<{ total: string | null; n: string }>(
        `SELECT sum(extract(epoch FROM (l.at - p.at)) * 1000)::text AS total, count(*)::text AS n
           FROM (SELECT order_id, min(at) AS at FROM order_events
                  WHERE kind IN ('pago_confirmado', 'cobro_manual_confirmado')
                    AND at >= $1 AND at < $2 GROUP BY order_id) p
           JOIN (SELECT order_id, min(at) AS at FROM order_events
                  WHERE kind = 'etiqueta_lista' GROUP BY order_id) l ON l.order_id = p.order_id
          WHERE l.at >= p.at`,
        [f, t],
      ),
      this.q.query<{ n: string }>(
        `SELECT ((SELECT count(DISTINCT order_id) FROM order_events
                   WHERE kind IN ('incidencia_envio', 'doble_pago_detectado')
                     AND at >= $1 AND at < $2)
               + (SELECT count(*) FROM order_flags WHERE opened_at >= $1 AND opened_at < $2))::text AS n`,
        [f, t],
      ),
      this.q.query<{ artists: string; repeated: string }>(
        `SELECT count(*)::text AS artists, count(*) FILTER (WHERE n >= 2)::text AS repeated
           FROM (SELECT o.artist_id, count(*) AS n FROM orders o
                  WHERE o.id IN ${paid} GROUP BY o.artist_id) x`,
        [f, t],
      ),
    ]);
    const o = orders.rows[0];
    return {
      listingsCreated: Number(listings.rows[0]?.n ?? 0),
      views: Number(views.rows[0]?.n ?? 0),
      paidOrders: Number(o?.paid ?? 0),
      cardOrders: Number(o?.card ?? 0),
      bizumOrders: Number(o?.bizum ?? 0),
      puntoOrders: Number(o?.punto ?? 0),
      recogidaOrders: Number(o?.recogida ?? 0),
      shippingChargedCents: Number(o?.shipping ?? 0),
      labelCostCents: Number(labels.rows[0]?.cost ?? 0),
      ordersWithLabelCost: Number(labels.rows[0]?.n ?? 0),
      payToLabelMsTotal: Math.round(Number(timing.rows[0]?.total ?? 0)),
      payToLabelCount: Number(timing.rows[0]?.n ?? 0),
      incidents: Number(incidents.rows[0]?.n ?? 0),
      artistsWithOrders: Number(artists.rows[0]?.artists ?? 0),
      repeatArtists: Number(artists.rows[0]?.repeated ?? 0),
    };
  }
}

export class PgManualFlagReader implements ManualFlagReader {
  constructor(private readonly q: Queryable) {}

  async hasOpen(orderId: string): Promise<boolean> {
    const res = await this.q.query(
      'SELECT 1 FROM order_flags WHERE order_id = $1 AND closed_at IS NULL',
      [orderId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
