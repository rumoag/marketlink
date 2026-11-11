import type { Instant } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';

/** Estados del pedido en U3. U4 a U6 anaden los posteriores sin cambiar estas transiciones. */
export const ORDER_STATUSES = [
  'pendiente_pago',
  'pagado',
  'expirado',
  'cancelado',
  'incidencia',
  'reembolsado',
  // U4: cadena de envio
  'error_borrador',
  'borrador_creado',
  'etiqueta_lista',
  'en_transito',
  'entregado',
  // U5: dinero
  'liquidado',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type PaymentMode = 'stripe' | 'manual';
export type Modality = 'punto' | 'recogida';
export type PackageSize = 'S' | 'M' | 'L';
export type RefundStatus = 'ninguno' | 'pendiente' | 'hecho' | 'fallido';

/** Rangos de importes (BR3-TT1): el precio de la obra viene del enlace; el envio, del proveedor. */
export const MIN_WORK_CENTS = 100;
export const MAX_WORK_CENTS = 100_000;
export const MIN_SHIPPING_CENTS = 1;
export const MAX_SHIPPING_CENTS = 10_000;

// ---------------------------------------------------------------------------------------------
// Copias inmutables que lleva el pedido (BR de pedido: la copia no cambia aunque se edite el enlace)
// ---------------------------------------------------------------------------------------------
export type OrderSnapshot = {
  readonly title: string;
  readonly priceCents: number;
  readonly modality: Modality;
  readonly size: PackageSize;
  readonly declaredValueCents: number;
  readonly fragile: boolean;
  readonly artisticName: string;
  readonly instagram: string;
};

export type SenderSnapshot = {
  readonly street: string;
  readonly number: string;
  readonly floorDoor: string;
  readonly postalCode: string;
  readonly city: string;
  readonly province: string;
  readonly phone: string;
};

/** Datos personales de la compradora: solo aqui (y en `Destination`). */
export type Buyer = { readonly name: string; readonly email: string; readonly phone: string };
/** U8: punto de recogida elegido por la compradora. Vive dentro de `Destination` (se purga con ella). */
export type DeliveryPointRef = {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly schedule: string;
};
export type Destination = {
  readonly street: string;
  readonly complement: string;
  readonly postalCode: string;
  readonly city: string;
  readonly province: string;
  /** Solo si el servicio elegido entrega en un punto (BR8-PT). */
  readonly point?: DeliveryPointRef | undefined;
};

export type QuoteRef = {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly transitDays: number;
  readonly priceCents: number;
  readonly modality: Modality;
  /** U8: pedidos anteriores no lo tienen (se muestra solo el servicio). */
  readonly carrier?: string | undefined;
  readonly destination?: 'domicilio' | 'punto' | undefined;
};

export type Consent = {
  readonly privacyVersion: string;
  readonly termsVersion: string;
  readonly acceptedAt: Instant;
};

export type Order = {
  readonly id: string;
  readonly listingId: string;
  readonly artistId: string;
  readonly status: OrderStatus;
  readonly version: number;
  readonly paymentMode: PaymentMode;
  readonly snapshot: OrderSnapshot;
  readonly sender: SenderSnapshot;
  /** `undefined` tras el borrado de datos personales. */
  readonly buyer: Buyer | undefined;
  readonly destination: Destination | undefined;
  readonly effectiveModality: Modality;
  readonly alternativeAccepted: boolean;
  readonly workPriceCents: number;
  readonly shippingCents: number;
  readonly totalCents: number;
  readonly commissionCents: 0;
  readonly quote: QuoteRef;
  readonly consent: Consent;
  readonly checkoutSessionId: string | undefined;
  readonly paymentIntentId: string | undefined;
  readonly reservationId: string | undefined;
  readonly trackingNonce: string;
  readonly trackingHash: string;
  readonly tokenKeyId: string;
  readonly resumeHash: string | undefined;
  readonly resumeExpiresAt: Instant | undefined;
  readonly submissionKey: string;
  readonly expiresAt: Instant;
  readonly refundStatus: RefundStatus;
  readonly refundReason: string | undefined;
  readonly refundId: string | undefined;
  readonly personalPurgedAt: Instant | undefined;
  /** U4: coste real de la etiqueta y margen del envio (puede ser negativo). */
  readonly labelCostCents?: number | undefined;
  readonly marginCents?: number | undefined;
  /** U5: identificador del cobro en el proveedor (para ligar la transferencia al cobro). */
  readonly chargeId?: string | undefined;
  /** U6: metodo real del cobro (se conoce al resolver el cargo). */
  readonly paymentMethod?: 'tarjeta' | 'bizum' | undefined;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

// ---------------------------------------------------------------------------------------------
// Totales (BR3-TT1 a TT4; P-U3-03)
// ---------------------------------------------------------------------------------------------
export type Totals = {
  readonly workPriceCents: number;
  readonly shippingCents: number;
  readonly totalCents: number;
};

const isInt = (n: number): boolean => Number.isSafeInteger(n);

/** total = obra + envio, en centimos enteros y dentro de rango; si no, error. */
export const computeTotals = (
  workPriceCents: number,
  shippingCents: number,
): Result<Totals, 'invalid_amount'> => {
  if (
    !isInt(workPriceCents) ||
    workPriceCents < MIN_WORK_CENTS ||
    workPriceCents > MAX_WORK_CENTS
  ) {
    return err('invalid_amount');
  }
  if (
    !isInt(shippingCents) ||
    shippingCents < MIN_SHIPPING_CENTS ||
    shippingCents > MAX_SHIPPING_CENTS
  ) {
    return err('invalid_amount');
  }
  return ok({ workPriceCents, shippingCents, totalCents: workPriceCents + shippingCents });
};

// ---------------------------------------------------------------------------------------------
// Maquina de estados (BR3-WH*, BR3-DP*, BR3-RT*, BR3-CC2; P-U3-07, P-U3-08)
// ---------------------------------------------------------------------------------------------
export type OrderEventKind =
  | 'creado'
  | 'pago_iniciado'
  | 'pago_confirmado'
  | 'sesion_expirada'
  | 'cancelado_por_comprador'
  | 'reserva_liberada'
  | 'obra_vendida'
  | 'doble_pago_detectado'
  | 'reembolso_solicitado'
  | 'reembolso_hecho'
  | 'reembolso_fallido'
  | 'cobro_manual_confirmado'
  | 'datos_purgados'
  | 'borrador_creado'
  | 'borrador_fallido'
  | 'etiqueta_lista'
  | 'en_transito'
  | 'entregado'
  | 'incidencia_envio'
  | 'recogida_elegida'
  | 'liquidado'
  | 'reembolso_parcial'
  | 'liberacion_manual'
  | 'entrega_sin_confirmar'
  | 'borrador_reintentado';

export type OrderActor = 'comprador' | 'artista' | 'sistema' | 'operador' | 'stripe';

/** Lo que ocurre en el mundo exterior y mueve el pedido. */
export type Trigger =
  /** Pago confirmado. `canSell`: la obra se puede vender a este pedido (reserva propia o recuperable). */
  | { readonly type: 'payment_completed'; readonly canSell: boolean }
  /** Cobro manual confirmado por la artista. */
  | { readonly type: 'manual_confirmed'; readonly canSell: boolean }
  | { readonly type: 'session_expired' }
  | { readonly type: 'deadline_passed' }
  | { readonly type: 'cancelled_by_buyer' }
  /** Stripe fallo al abrir la sesion de pago (todo o nada, BR3-RS4). */
  | { readonly type: 'provider_failed' }
  | { readonly type: 'refund_done' }
  /** U5: la parte de la artista se ha transferido. */
  | { readonly type: 'settled' }
  /** U5: reembolso total completado de un pedido no liquidado. */
  | { readonly type: 'refund_total' };

/** Efectos que debe ejecutar quien aplica la transicion, dentro de la misma transaccion. */
export type Effect = 'mark_sold' | 'release_reservation' | 'request_refund';

export type Transition = {
  readonly status: OrderStatus;
  readonly effects: readonly Effect[];
  readonly kind: OrderEventKind | undefined;
  readonly reasonCode: string | undefined;
  /** Verdadero si el pedido cambia (o debe registrarse un evento); falso si es idempotente. */
  readonly changed: boolean;
};

const noop = (status: OrderStatus): Transition => ({
  status,
  effects: [],
  kind: undefined,
  reasonCode: undefined,
  changed: false,
});

const sold = (kind: OrderEventKind): Transition => ({
  status: 'pagado',
  effects: ['mark_sold'],
  kind,
  reasonCode: undefined,
  changed: true,
});

const refundedTotal: Transition = {
  status: 'reembolsado',
  effects: [],
  kind: 'reembolso_hecho',
  reasonCode: 'reembolso_total',
  changed: true,
};

const lost: Transition = {
  status: 'incidencia',
  effects: ['request_refund'],
  kind: 'doble_pago_detectado',
  reasonCode: 'obra_no_disponible',
  changed: true,
};

/**
 * Funcion pura `aplicar(estado, disparador)`. Repetir un disparador ya aplicado (o que no tiene
 * efecto en el estado actual) devuelve `changed = false` y ningun efecto: idempotente.
 *
 *  - `pagado`, `incidencia` (salvo `refund_done`) y `reembolsado` absorben todo.
 *  - Un pago llega tarde a `expirado` o `cancelado`: se recupera la obra o se reembolsa.
 */
export const applyTrigger = (status: OrderStatus, trigger: Trigger): Transition => {
  switch (status) {
    case 'pendiente_pago':
      switch (trigger.type) {
        case 'payment_completed':
          return trigger.canSell ? sold('pago_confirmado') : lost;
        case 'manual_confirmed':
          return trigger.canSell ? sold('cobro_manual_confirmado') : noop(status);
        case 'session_expired':
        case 'deadline_passed':
          return {
            status: 'expirado',
            effects: ['release_reservation'],
            kind: 'sesion_expirada',
            reasonCode: trigger.type === 'deadline_passed' ? 'reserva_vencida' : undefined,
            changed: true,
          };
        case 'cancelled_by_buyer':
        case 'provider_failed':
          return {
            status: 'cancelado',
            effects: ['release_reservation'],
            kind: 'cancelado_por_comprador',
            reasonCode: trigger.type === 'provider_failed' ? 'error_proveedor' : undefined,
            changed: true,
          };
        case 'refund_done':
          return noop(status);
      }
      return noop(status);
    case 'expirado':
    case 'cancelado':
      // Pago tardio: el dinero ya se cobro; se acepta si la obra sigue libre, si no se reembolsa.
      if (trigger.type === 'payment_completed') {
        return trigger.canSell ? sold('pago_confirmado') : lost;
      }
      return noop(status);
    case 'incidencia':
      if (trigger.type === 'refund_done' || trigger.type === 'refund_total') {
        return {
          status: 'reembolsado',
          effects: [],
          kind: 'reembolso_hecho',
          reasonCode: undefined,
          changed: true,
        };
      }
      return noop(status);
    // U4: los estados de envio no los mueve ningun disparador de pago (los mueven los hechos de transporte).
    // U5: un reembolso total saca del flujo a los pedidos pagados no liquidados; `settled` liquida un entregado.
    case 'pagado':
    case 'error_borrador':
    case 'borrador_creado':
    case 'etiqueta_lista':
    case 'en_transito':
      return trigger.type === 'refund_total' ? refundedTotal : noop(status);
    case 'entregado':
      if (trigger.type === 'settled') {
        return {
          status: 'liquidado',
          effects: [],
          kind: 'liquidado',
          reasonCode: undefined,
          changed: true,
        };
      }
      return trigger.type === 'refund_total' ? refundedTotal : noop(status);
    case 'reembolsado':
    case 'liquidado':
      return noop(status);
  }
};

/** Estados desde los que un pago confirmado puede acabar en venta. */
export const canReceivePayment = (status: OrderStatus): boolean =>
  status === 'pendiente_pago' || status === 'expirado' || status === 'cancelado';

/** Estados en los que el pedido ya no admite cancelar ni expirar. */
export const isTerminalForCheckout = (status: OrderStatus): boolean =>
  status === 'pagado' || status === 'incidencia' || status === 'reembolsado';

/** Un pedido `pendiente_pago` cuyo plazo (mas el margen) ya vencio debe cerrarlo el respaldo (P-U3-20). */
export const SWEEP_GRACE_MS = 2 * 60_000;
export const isOverdue = (order: Pick<Order, 'status' | 'expiresAt'>, now: Instant): boolean =>
  order.status === 'pendiente_pago' && order.expiresAt + SWEEP_GRACE_MS <= now;

// ---------------------------------------------------------------------------------------------
// Evento de pedido (solo insercion; sin datos personales)
// ---------------------------------------------------------------------------------------------
export type OrderEvent = {
  readonly orderId: string;
  readonly artistId: string;
  readonly at: Instant;
  readonly actor: OrderActor;
  readonly kind: OrderEventKind;
  readonly fromStatus: OrderStatus;
  readonly toStatus: OrderStatus;
  readonly reasonCode: string | undefined;
  readonly externalRef: string | undefined;
};

/** Datos personales que nunca pueden aparecer en eventos, trabajos ni metadatos (P-U3-14). */
export const personalValues = (order: Pick<Order, 'buyer' | 'destination'>): string[] => {
  const values: string[] = [];
  if (order.buyer) values.push(order.buyer.name, order.buyer.email, order.buyer.phone);
  if (order.destination) {
    values.push(order.destination.street, order.destination.complement);
  }
  return values.filter((v) => v.length >= 3);
};

/** Vacia los datos personales (retencion, NFR-U3-26). Idempotente. */
export const purgePersonalData = (order: Order, now: Instant): Order =>
  order.personalPurgedAt !== undefined
    ? order
    : {
        ...order,
        buyer: undefined,
        destination: undefined,
        resumeHash: undefined,
        resumeExpiresAt: undefined,
        personalPurgedAt: now,
        updatedAt: now,
      };

/**
 * U8 (US-064, US-065, US-070): como se entrega el pedido. Pedidos anteriores a U8 no guardan el destino
 * ni el transportista: solo se muestra el servicio (BR8-H1). El punto vive en `destination` y
 * desaparece con la purga de datos personales.
 */
export type DeliverySummary = {
  readonly serviceName: string;
  readonly carrier: string | undefined;
  readonly transitDays: number;
  readonly destination: 'domicilio' | 'punto' | undefined;
  readonly point: DeliveryPointRef | undefined;
};

export const deliverySummary = (order: Pick<Order, 'quote' | 'destination'>): DeliverySummary => ({
  serviceName: order.quote.serviceName,
  carrier: order.quote.carrier,
  transitDays: order.quote.transitDays,
  destination: order.quote.destination,
  point: order.destination?.point,
});
