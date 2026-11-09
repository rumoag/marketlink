import type { Instant } from '@/modules/kernel/domain/clock';
import type {
  DropoffPoint,
  Incident,
  PickupOption,
  ShipmentState,
  ShipmentStatus,
} from './shipment';

/** Envio de un pedido en el transportista. Uno por pedido; sin datos personales. */
export type Shipment = {
  readonly id: string;
  readonly orderId: string;
  readonly artistId: string;
  readonly status: ShipmentStatus;
  readonly incident: Incident | undefined;
  readonly failureReason: string | undefined;
  readonly providerRef: string | undefined;
  readonly serviceId: string;
  readonly carrierName: string | undefined;
  readonly labelKey: string | undefined;
  readonly trackingUrl: string | undefined;
  readonly trackingCode: string | undefined;
  readonly pickup: PickupOption | undefined;
  readonly pickupOptions: readonly PickupOption[] | undefined;
  readonly dropoffPoints: readonly DropoffPoint[] | undefined;
  readonly labelCostCents: number | undefined;
  readonly lastProviderEventAt: Instant | undefined;
  readonly nextPollAt: Instant | undefined;
  readonly pickupRequestedAt: Instant | undefined;
  readonly pickupRemindedAt: Instant | undefined;
  readonly pickupOperatorAlertedAt: Instant | undefined;
  readonly payRemindedAt: Instant | undefined;
  readonly draftCreatedAt: Instant | undefined;
  readonly deliveredAt: Instant | undefined;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export const newShipment = (input: {
  id: string;
  orderId: string;
  artistId: string;
  serviceId: string;
  carrierName: string | undefined;
  now: Instant;
}): Shipment => ({
  id: input.id,
  orderId: input.orderId,
  artistId: input.artistId,
  status: 'creando',
  incident: undefined,
  failureReason: undefined,
  providerRef: undefined,
  serviceId: input.serviceId,
  carrierName: input.carrierName,
  labelKey: undefined,
  trackingUrl: undefined,
  trackingCode: undefined,
  pickup: undefined,
  pickupOptions: undefined,
  dropoffPoints: undefined,
  labelCostCents: undefined,
  lastProviderEventAt: undefined,
  nextPollAt: undefined,
  pickupRequestedAt: undefined,
  pickupRemindedAt: undefined,
  pickupOperatorAlertedAt: undefined,
  payRemindedAt: undefined,
  draftCreatedAt: undefined,
  deliveredAt: undefined,
  createdAt: input.now,
  updatedAt: input.now,
});

export const stateOf = (s: Shipment): ShipmentState => ({
  status: s.status,
  incident: s.incident,
  draftFailed: s.failureReason === 'borrador',
  lastEventAt: s.lastProviderEventAt,
});
