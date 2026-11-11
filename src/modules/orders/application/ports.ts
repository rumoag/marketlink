import type { AppError } from '@/modules/kernel/domain/app-error';
import type { Instant } from '@/modules/kernel/domain/clock';
import type { Result } from '@/modules/kernel/domain/result';
import type { Modality, Order, OrderEvent, PackageSize } from '../domain/order';

/** Lanzada al insertar un pedido con una clave de envio que ya existe (doble clic, reintento). */
export class SubmissionKeyTakenError extends Error {
  constructor() {
    super('submission_key_taken');
    this.name = 'SubmissionKeyTakenError';
  }
}

export interface OrderRepository {
  /** Lanza SubmissionKeyTakenError si la clave de envio ya existe. */
  insert(order: Order): Promise<void>;
  findById(id: string): Promise<Order | undefined>;
  /** Igual que findById pero bloquea la fila hasta el fin de la transaccion. */
  findByIdForUpdate(id: string): Promise<Order | undefined>;
  findBySubmissionKey(key: string): Promise<Order | undefined>;
  findByCheckoutSession(sessionId: string): Promise<Order | undefined>;
  findByTrackingHash(hash: string): Promise<Order | undefined>;
  findByResumeHash(hash: string): Promise<Order | undefined>;
  /**
   * Guarda el pedido solo si su version en base de datos es `order.version - 1`
   * (concurrencia optimista, BR3-CC1). Devuelve falso si otro proceso lo cambio antes.
   */
  save(order: Order): Promise<boolean>;
  listByArtist(artistId: string, limit: number): Promise<Order[]>;
  /** Contexto de sistema: `pendiente_pago` con el plazo vencido mas el margen. */
  listOverdue(now: Instant, limit: number): Promise<Order[]>;
  /** Contexto de sistema: cancelados o expirados con datos personales y mas viejos que `before`. */
  listPurgeable(before: Instant, limit: number): Promise<Order[]>;
  /** U5: pedidos `en_transito` desde antes de `before` (entrega sin confirmar). */
  listStaleInTransit(before: Instant, limit: number): Promise<Order[]>;
  /** U5: pedidos pagados (cadena de envio o liquidados) creados entre `from` y `to`. */
  listPaidBetween(from: Instant, to: Instant, limit: number): Promise<Order[]>;
  /** U5: pedido por el pago de Stripe (eventos del cobro). */
  findByPaymentIntent(paymentIntentId: string): Promise<Order | undefined>;
  /** Contexto de sistema: pedidos con pago de Stripe creados desde `since` (conciliacion). */
  listStripeSince(since: Instant, limit: number): Promise<Order[]>;
}

export interface OrderEventStore {
  append(event: OrderEvent): Promise<void>;
  listByOrder(orderId: string): Promise<OrderEvent[]>;
}

/** Telefono de Bizum que la artista publica solo para el modo manual (Q5a A). */
export interface ArtistContactRepository {
  findBizumPhone(artistId: string): Promise<string | undefined>;
  /** Email de acceso de la artista (para avisos y factura). */
  findEmail(artistId: string): Promise<string | undefined>;
  saveBizumPhone(artistId: string, phone: string | undefined, now: Instant): Promise<void>;
}

/** La obra tal como la necesita la compra (leida con el contexto del sistema). */
export type CheckoutListing = {
  readonly id: string;
  readonly artistId: string;
  readonly slug: string;
  readonly status: 'activo' | 'pausado' | 'vendido';
  readonly title: string;
  readonly description: string;
  readonly priceCents: number;
  readonly declaredValueCents: number;
  readonly fragile: boolean;
  readonly size: PackageSize;
  readonly modality: Modality;
  /** U8: origenes que la artista acepta (BR8-O4). */
  readonly origins: readonly Modality[];
  readonly artisticName: string;
  readonly instagram: string;
  readonly sender: {
    readonly street: string;
    readonly number: string;
    readonly floorDoor: string;
    readonly postalCode: string;
    readonly city: string;
    readonly province: string;
    readonly phone: string;
  };
  readonly parcel: {
    readonly lengthCm: number;
    readonly widthCm: number;
    readonly heightCm: number;
    readonly weightKg: number;
  };
  /** Hay una reserva vigente (de cualquier pedido). */
  readonly reserved: boolean;
};

export type ReserveFailure = 'not_found' | 'not_available' | 'already_reserved';

/**
 * Operaciones sobre el enlace dentro de la MISMA transaccion que el pedido (el contrato de U2
 * lleva su propia transaccion; aqui hace falta atomicidad con el pedido). Implementado en
 * `src/services` sobre los repositorios de ACC y LST.
 */
export interface ListingSalesPort {
  findBySlug(slug: string): Promise<CheckoutListing | undefined>;
  findById(listingId: string): Promise<CheckoutListing | undefined>;
  /** Bloquea el enlace y crea una reserva activa. */
  reserve(
    listingId: string,
    ttlMs: number,
  ): Promise<Result<{ reservationId: string }, ReserveFailure>>;
  /**
   * Con el enlace bloqueado: ¿se puede vender a este pedido? Si, cuando el enlace esta activo
   * y su reserva vigente es la del pedido, o no hay ninguna reserva vigente (pago tardio).
   */
  canSell(listingId: string, reservationId: string | undefined): Promise<boolean>;
  /** Consume la reserva (o la crea si ya no existe) y marca el enlace vendido a este pedido. */
  sell(
    listingId: string,
    orderId: string,
    reservationId: string | undefined,
  ): Promise<Result<void, 'not_sellable'>>;
  release(reservationId: string): Promise<void>;
}

export type OrdersRepos = {
  readonly orders: OrderRepository;
  readonly orderEvents: OrderEventStore;
  readonly sales: ListingSalesPort;
  readonly contacts: ArtistContactRepository;
};

// ---------------------------------------------------------------------------------------------
// Proveedor de pagos
// ---------------------------------------------------------------------------------------------
export type CheckoutSession = {
  readonly id: string;
  readonly url: string | undefined;
  readonly status: 'abierta' | 'completada' | 'expirada';
  readonly paid: boolean;
  readonly paymentIntentId: string | undefined;
  readonly orderId: string | undefined;
  readonly amountCents: number | undefined;
};

export type PaymentMethod = 'card' | 'bizum';

export type CreateSessionInput = {
  readonly orderId: string;
  readonly workTitle: string;
  readonly workPriceCents: number;
  readonly shippingCents: number;
  readonly customerEmail: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly expiresAt: Instant;
  readonly methods: readonly PaymentMethod[];
  readonly idempotencyKey: string;
};

/** Evento de Stripe reducido a lo que usa el dominio (sin datos personales, BR3-PG3). */
export type PaymentEvent = {
  readonly id: string;
  readonly type:
    | 'completed'
    | 'expired'
    | 'async_succeeded'
    | 'async_failed'
    // U5: eventos del cobro (solo generan avisos, no mueven el pedido)
    | 'charge_refunded'
    | 'dispute_created';
  readonly sessionId: string;
  readonly orderId: string | undefined;
  readonly paymentIntentId: string | undefined;
  readonly paid: boolean;
  readonly amountCents: number | undefined;
};

export type PaidSession = {
  readonly sessionId: string;
  readonly orderId: string | undefined;
  readonly paymentIntentId: string | undefined;
  readonly amountCents: number;
};

export interface PaymentProvider {
  createCheckoutSession(input: CreateSessionInput): Promise<Result<CheckoutSession, AppError>>;
  /** Caduca la sesion; si ya estaba pagada la devuelve como `completada`. */
  expireSession(sessionId: string): Promise<Result<CheckoutSession, AppError>>;
  getSession(sessionId: string): Promise<Result<CheckoutSession, AppError>>;
  listPaidSessions(since: Instant): Promise<Result<PaidSession[], AppError>>;
  /** Reembolso total e idempotente; si ya existe uno para el pago, lo devuelve. */
  refund(input: {
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<Result<{ refundId: string }, AppError>>;
  /** Verifica la firma sobre el cuerpo crudo y reduce el evento (null si no nos interesa). */
  parseEvent(rawBody: string, signature: string): Result<PaymentEvent | null, 'invalid_signature'>;
}

// ---------------------------------------------------------------------------------------------
// Avisos al operador
// ---------------------------------------------------------------------------------------------
export type OperatorAlertCode =
  | 'packlink_no_disponible'
  | 'doble_pago'
  | 'reembolso_fallido'
  | 'conciliacion_desajuste'
  | 'enlace_bloqueado_abuso'
  // U4
  | 'packlink_borrador_fallido'
  | 'etiqueta_no_descargada'
  | 'incidencia_envio'
  | 'recogida_sin_elegir'
  | 'email_fallido'
  | 'borrador_sin_pagar'
  // U5
  | 'liquidacion_bloqueada'
  | 'liquidacion_fallida'
  | 'liquidacion_sin_cargo'
  | 'retirada_fallida'
  | 'entrega_sin_confirmar'
  | 'disputa_abierta'
  | 'reembolso_externo'
  // U6
  | 'acceso_operador_bloqueado'
  // U7
  | 'seguridad_autenticacion'
  | 'seguridad_autorizacion'
  | 'seguridad_webhook'
  | 'auditoria_voluminosa'
  | 'limpieza_datos_fallida';

/** Sin datos personales: solo identificadores y codigos. */
export type AlertContext = {
  readonly orderId?: string;
  readonly listingId?: string;
  readonly postalCode?: string;
  readonly detail?: string;
};

export interface OperatorAlerts {
  raise(code: OperatorAlertCode, context: AlertContext, correlationId: string): Promise<void>;
}
