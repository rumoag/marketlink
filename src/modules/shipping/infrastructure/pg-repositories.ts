import { instantOf, type Instant } from '@/modules/kernel/domain/clock';
import type { Queryable } from '@/modules/platform/infrastructure/pg-runner';
import type { ShipmentRepository } from '../application/ports';
import type { Shipment } from '../domain/entity';
import type { DropoffPoint, Incident, PickupOption, ShipmentStatus } from '../domain/shipment';

const at = (d: Date | null): Instant | undefined => (d ? instantOf(d.getTime()) : undefined);
const ts = (t: Instant | undefined): Date | null => (t === undefined ? null : new Date(t));
const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

type Row = {
  id: string;
  order_id: string;
  artist_id: string;
  status: ShipmentStatus;
  incident: Incident | null;
  failure_reason: string | null;
  provider_ref: string | null;
  service_id: string;
  carrier_name: string | null;
  label_key: string | null;
  tracking_url: string | null;
  tracking_code: string | null;
  pickup: PickupOption | null;
  pickup_options: PickupOption[] | null;
  dropoff_points: DropoffPoint[] | null;
  label_cost_cents: number | null;
  last_provider_event_at: Date | null;
  next_poll_at: Date | null;
  pickup_requested_at: Date | null;
  pickup_reminded_at: Date | null;
  pickup_operator_alerted_at: Date | null;
  pay_reminded_at: Date | null;
  draft_created_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const toShipment = (r: Row): Shipment => ({
  id: r.id,
  orderId: r.order_id,
  artistId: r.artist_id,
  status: r.status,
  incident: r.incident ?? undefined,
  failureReason: r.failure_reason ?? undefined,
  providerRef: r.provider_ref ?? undefined,
  serviceId: r.service_id,
  carrierName: r.carrier_name ?? undefined,
  labelKey: r.label_key ?? undefined,
  trackingUrl: r.tracking_url ?? undefined,
  trackingCode: r.tracking_code ?? undefined,
  pickup: r.pickup ?? undefined,
  pickupOptions: r.pickup_options ?? undefined,
  dropoffPoints: r.dropoff_points ?? undefined,
  labelCostCents: r.label_cost_cents ?? undefined,
  lastProviderEventAt: at(r.last_provider_event_at),
  nextPollAt: at(r.next_poll_at),
  pickupRequestedAt: at(r.pickup_requested_at),
  pickupRemindedAt: at(r.pickup_reminded_at),
  pickupOperatorAlertedAt: at(r.pickup_operator_alerted_at),
  payRemindedAt: at(r.pay_reminded_at),
  draftCreatedAt: at(r.draft_created_at),
  deliveredAt: at(r.delivered_at),
  createdAt: instantOf(r.created_at.getTime()),
  updatedAt: instantOf(r.updated_at.getTime()),
});

export class PgShipmentRepository implements ShipmentRepository {
  constructor(private readonly q: Queryable) {}

  async insert(s: Shipment): Promise<void> {
    await this.q.query(
      `INSERT INTO shipments (id, order_id, artist_id, status, service_id, carrier_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [s.id, s.orderId, s.artistId, s.status, s.serviceId, s.carrierName ?? null, ts(s.createdAt)],
    );
  }

  private async one(sql: string, params: unknown[]): Promise<Shipment | undefined> {
    const res = await this.q.query<Row>(sql, params);
    return res.rows[0] ? toShipment(res.rows[0]) : undefined;
  }

  findByOrder(orderId: string): Promise<Shipment | undefined> {
    return this.one('SELECT * FROM shipments WHERE order_id = $1', [orderId]);
  }
  findByOrderForUpdate(orderId: string): Promise<Shipment | undefined> {
    return this.one('SELECT * FROM shipments WHERE order_id = $1 FOR UPDATE', [orderId]);
  }
  findByProviderRefForUpdate(providerRef: string): Promise<Shipment | undefined> {
    return this.one('SELECT * FROM shipments WHERE provider_ref = $1 FOR UPDATE', [providerRef]);
  }

  async save(s: Shipment): Promise<void> {
    await this.q.query(
      `UPDATE shipments SET
         status = $2, incident = $3, failure_reason = $4, provider_ref = $5, carrier_name = $6,
         label_key = $7, tracking_url = $8, tracking_code = $9, pickup = $10::jsonb,
         pickup_options = $11::jsonb, dropoff_points = $12::jsonb, label_cost_cents = $13,
         last_provider_event_at = $14, next_poll_at = $15, pickup_requested_at = $16,
         pickup_reminded_at = $17, pickup_operator_alerted_at = $18, pay_reminded_at = $19,
         draft_created_at = $20, delivered_at = $21, updated_at = $22
       WHERE id = $1`,
      [
        s.id,
        s.status,
        s.incident ?? null,
        s.failureReason ?? null,
        s.providerRef ?? null,
        s.carrierName ?? null,
        s.labelKey ?? null,
        s.trackingUrl ?? null,
        s.trackingCode ?? null,
        json(s.pickup),
        json(s.pickupOptions),
        json(s.dropoffPoints),
        s.labelCostCents ?? null,
        ts(s.lastProviderEventAt),
        ts(s.nextPollAt),
        ts(s.pickupRequestedAt),
        ts(s.pickupRemindedAt),
        ts(s.pickupOperatorAlertedAt),
        ts(s.payRemindedAt),
        ts(s.draftCreatedAt),
        ts(s.deliveredAt),
        ts(s.updatedAt),
      ],
    );
  }

  async claimDueForPolling(now: Instant, limit: number, leaseMs: number): Promise<Shipment[]> {
    const res = await this.q.query<Row>(
      `UPDATE shipments SET next_poll_at = $3
        WHERE id IN (
          SELECT id FROM shipments
           WHERE next_poll_at IS NOT NULL AND next_poll_at <= $1 AND provider_ref IS NOT NULL
             AND status <> 'entregado'
           ORDER BY next_poll_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [ts(now), limit, ts(((now as number) + leaseMs) as Instant)],
    );
    return res.rows.map(toShipment);
  }

  async listAwaitingPickup(limit: number): Promise<Shipment[]> {
    const res = await this.q.query<Row>(
      `SELECT * FROM shipments
        WHERE status = 'creando' AND pickup IS NULL AND pickup_requested_at IS NOT NULL
        ORDER BY pickup_requested_at LIMIT $1`,
      [limit],
    );
    return res.rows.map(toShipment);
  }

  async listDrafts(limit: number): Promise<Shipment[]> {
    const res = await this.q.query<Row>(
      `SELECT * FROM shipments WHERE status = 'borrador' AND draft_created_at IS NOT NULL
        ORDER BY draft_created_at LIMIT $1`,
      [limit],
    );
    return res.rows.map(toShipment);
  }

  async listLabelPurgeable(
    deliveredBefore: Instant,
    createdBefore: Instant,
    limit: number,
  ): Promise<Shipment[]> {
    const res = await this.q.query<Row>(
      `SELECT * FROM shipments
        WHERE label_key IS NOT NULL
          AND ((delivered_at IS NOT NULL AND delivered_at < $1)
               OR (delivered_at IS NULL AND created_at < $2))
        ORDER BY created_at LIMIT $3`,
      [ts(deliveredBefore), ts(createdBefore), limit],
    );
    return res.rows.map(toShipment);
  }
}
