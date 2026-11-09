import type { AppError } from '@/modules/kernel/domain/app-error';
import type { Instant } from '@/modules/kernel/domain/clock';
import type { Result } from '@/modules/kernel/domain/result';
import type { NotificationRepository } from '@/modules/notifications/application/ports';
import type { Modality, PackageSize } from '@/modules/orders/domain/order';
import type { Shipment } from '../domain/entity';
import type { DropoffPoint, PickupOption, ShipmentFact } from '../domain/shipment';

export interface ShipmentRepository {
  insert(shipment: Shipment): Promise<void>;
  findByOrder(orderId: string): Promise<Shipment | undefined>;
  findByOrderForUpdate(orderId: string): Promise<Shipment | undefined>;
  findByProviderRefForUpdate(providerRef: string): Promise<Shipment | undefined>;
  /** Guarda el envio (el llamador ya lo tiene bloqueado). */
  save(shipment: Shipment): Promise<void>;
  /**
   * Toma hasta `limit` envios abiertos con `nextPollAt <= now` y los reserva `leaseMs`
   * (mueve `nextPollAt`), de forma exclusiva entre ejecutores.
   */
  claimDueForPolling(now: Instant, limit: number, leaseMs: number): Promise<Shipment[]>;
  /** Envios en `creando` que esperan la eleccion de recogida. */
  listAwaitingPickup(limit: number): Promise<Shipment[]>;
  /** Borradores sin pagar (estado `borrador`). */
  listDrafts(limit: number): Promise<Shipment[]>;
  /** Con etiqueta guardada y plazo de retencion vencido. */
  listLabelPurgeable(
    deliveredBefore: Instant,
    createdBefore: Instant,
    limit: number,
  ): Promise<Shipment[]>;
}

/** Repositorios de una transaccion para este modulo. */
export type ShippingRepos = {
  readonly shipments: ShipmentRepository;
  readonly notifications: NotificationRepository;
};

export type DraftInput = {
  /** Referencia propia del envio: el id del pedido (idempotencia). */
  readonly reference: string;
  readonly serviceId: string;
  readonly sender: {
    readonly name: string;
    readonly street: string;
    readonly number: string;
    readonly floorDoor: string;
    readonly postalCode: string;
    readonly city: string;
    readonly province: string;
    readonly phone: string;
  };
  readonly recipient: {
    readonly name: string;
    readonly email: string;
    readonly phone: string;
    readonly street: string;
    readonly complement: string;
    readonly postalCode: string;
    readonly city: string;
    readonly province: string;
  };
  readonly parcel: {
    readonly size: PackageSize;
    readonly lengthCm: number;
    readonly widthCm: number;
    readonly heightCm: number;
    readonly weightKg: number;
  };
  readonly declaredValueCents: number;
  readonly fragile: boolean;
  readonly modality: Modality;
  readonly pickup: PickupOption | undefined;
};

/** Operaciones de envio del transportista (Packlink). Errores = proveedor caido o rechazo. */
export interface ShipmentProvider {
  findByReference(
    reference: string,
  ): Promise<Result<{ providerRef: string } | undefined, AppError>>;
  createDraft(input: DraftInput): Promise<Result<{ providerRef: string }, AppError>>;
  /** Hechos actuales del envio (estado y seguimiento) para la consulta de respaldo. */
  fetchFacts(providerRef: string): Promise<Result<readonly ShipmentFact[], AppError>>;
  getLabel(providerRef: string): Promise<Result<Uint8Array, AppError>>;
  getDropoffs(
    serviceId: string,
    postalCode: string,
  ): Promise<Result<readonly DropoffPoint[], AppError>>;
  getPickupOptions(
    serviceId: string,
    postalCode: string,
  ): Promise<Result<readonly PickupOption[], AppError>>;
}

export interface LabelStorage {
  put(key: string, bytes: Uint8Array): Promise<Result<void, AppError>>;
  /** URL firmada de vida corta. */
  signedUrl(key: string, ttlSeconds: number): Promise<Result<string, AppError>>;
  remove(keys: readonly string[]): Promise<Result<void, AppError>>;
}

export type DraftInvoice = {
  readonly orderRef: string;
  readonly issuedAt: Instant;
  readonly artistName: string;
  readonly artistEmail: string;
  readonly artistAddress: string;
  readonly platformName: string;
  readonly title: string;
  readonly workCents: number;
  readonly shippingCents: number;
  readonly totalCents: number;
};

export interface InvoiceRenderer {
  render(invoice: DraftInvoice): Promise<Uint8Array>;
}
