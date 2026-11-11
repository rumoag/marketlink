import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { Notification } from '@/modules/notifications/domain/notification';
import type { GetTracking, TrackingResult } from '@/modules/orders/application/queries';
import {
  deliverySummary,
  type DeliverySummary,
  type Order,
  type OrderEvent,
} from '@/modules/orders/domain/order';
import { hashTrackingToken, isWellFormedToken } from '@/modules/orders/domain/tracking-token';
import { systemScope } from '@/modules/platform/application/unit-of-work';
import type { Shipment } from '../domain/entity';
import { nextAction, type NextAction, type PickupOption } from '../domain/shipment';
import type { ShippingRunner } from './apply-fact';

const generic = (): AppError => appError('not_found');

export type ArtistOrderDetail = {
  readonly id: string;
  readonly title: string;
  readonly status: Order['status'];
  readonly modality: Order['effectiveModality'];
  /** U8: servicio, transportista, plazo y destino elegidos por la compradora (US-065). */
  readonly delivery: DeliverySummary;
  readonly totalCents: number;
  readonly workPriceCents: number;
  readonly shippingCents: number;
  readonly next: NextAction;
  /** Direccion completa solo mientras hace falta para el envio (BR4-SG3); si no, solo la localidad. */
  readonly destination: { readonly full: string | undefined; readonly city: string | undefined };
  readonly pickupOptions: readonly PickupOption[];
  readonly pickupChosen: PickupOption | undefined;
  readonly dropoffPoints: Shipment['dropoffPoints'];
  readonly hasLabel: boolean;
  readonly trackingUrl: string | undefined;
  readonly failedNotifications: number;
  readonly invoiceAvailable: boolean;
};

const ADDRESS_STATUSES = new Set([
  'pagado',
  'error_borrador',
  'borrador_creado',
  'etiqueta_lista',
  'en_transito',
]);

/** Detalle del pedido para su artista (US-036, BR4-SG2, BR4-SG3). */
export class GetArtistOrder {
  constructor(private readonly deps: { readonly runner: ShippingRunner; readonly clock: Clock }) {}

  async execute(artistId: string, orderId: string): Promise<Result<ArtistOrderDetail, AppError>> {
    const data = await this.deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findById(orderId);
      if (!order || order.artistId !== artistId) return undefined;
      const shipment = await repos.shipments.findByOrder(orderId);
      const failed = await repos.notifications.listFailedByArtist(artistId);
      return { order, shipment, failed };
    });
    if (!data) return err(generic());
    const { order, shipment, failed } = data;
    const pickupText = shipment?.pickup
      ? `${shipment.pickup.date} (${shipment.pickup.slot})`
      : undefined;
    const next = nextAction({
      orderStatus: order.status,
      modality: order.effectiveModality,
      pickupChosen: shipment?.pickup !== undefined,
      pickupText,
    });
    const d = order.destination;
    const showAddress =
      ADDRESS_STATUSES.has(order.status) && d !== undefined && order.buyer !== undefined;
    return ok({
      id: order.id,
      title: order.snapshot.title,
      status: order.status,
      modality: order.effectiveModality,
      delivery: deliverySummary(order),
      totalCents: order.totalCents,
      workPriceCents: order.workPriceCents,
      shippingCents: order.shippingCents,
      next,
      destination: {
        full:
          showAddress && d && order.buyer
            ? `${order.buyer.name}, ${d.street}${d.complement ? ` ${d.complement}` : ''}, ${d.postalCode} ${d.city} (${d.province}). Tel. ${order.buyer.phone}`
            : undefined,
        city: d?.city,
      },
      pickupOptions: shipment?.pickupOptions ?? [],
      pickupChosen: shipment?.pickup,
      dropoffPoints: shipment?.dropoffPoints,
      hasLabel: shipment?.labelKey !== undefined,
      trackingUrl: shipment?.trackingUrl,
      failedNotifications: failed.filter((n: Notification) => n.orderId === orderId).length,
      invoiceAvailable:
        order.status !== 'pendiente_pago' &&
        order.status !== 'expirado' &&
        order.status !== 'cancelado' &&
        order.status !== 'reembolsado' &&
        !(order.status === 'incidencia' && order.refundStatus !== 'ninguno'),
    });
  }
}

export type TrackingStep = { readonly label: string; readonly atMs: number };
export type TrackingDetails = TrackingResult & {
  readonly history: readonly TrackingStep[];
  readonly carrierUrl: string | undefined;
};

const STEP_LABEL: Partial<Record<OrderEvent['kind'], string>> = {
  pago_confirmado: 'Pago recibido',
  cobro_manual_confirmado: 'Pago recibido',
  borrador_creado: 'Preparando el envío',
  etiqueta_lista: 'Etiqueta lista',
  en_transito: 'En camino',
  entregado: 'Entregado',
  incidencia_envio: 'Estamos revisando el envío',
};

/** Seguimiento de la compradora con historial y enlace del transportista (US-035, BR4-SG1). */
export class GetTrackingDetails {
  constructor(
    private readonly deps: {
      readonly base: Pick<GetTracking, 'execute'>;
      readonly runner: ShippingRunner;
    },
  ) {}

  async execute(
    rawToken: string,
    ip: string,
    correlationId: string,
  ): Promise<Result<TrackingDetails, AppError>> {
    const base = await this.deps.base.execute(rawToken, ip, correlationId);
    if (!base.ok) return base;
    if (!isWellFormedToken(rawToken)) return err(generic());
    const extra = await this.deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findByTrackingHash(hashTrackingToken(rawToken));
      if (!order) return undefined;
      const [events, shipment] = await Promise.all([
        repos.orderEvents.listByOrder(order.id),
        repos.shipments.findByOrder(order.id),
      ]);
      return { events, shipment };
    });
    const history: TrackingStep[] = [];
    for (const e of (extra?.events ?? []).slice(0, 50)) {
      const label = STEP_LABEL[e.kind];
      if (label && history.at(-1)?.label !== label) history.push({ label, atMs: e.at });
    }
    return ok({ ...base.value, history, carrierUrl: extra?.shipment?.trackingUrl });
  }
}
