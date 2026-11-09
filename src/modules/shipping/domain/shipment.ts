import { instantOf, MS, type Instant } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { NotificationType } from '@/modules/notifications/domain/notification';
import type { Modality, OrderEventKind, OrderStatus } from '@/modules/orders/domain/order';

// ---------------------------------------------------------------------------------------------
// Estado del envio y hechos de transporte (BR4-ES1, BR4-IN*, P-U4-01 a P-U4-04)
// ---------------------------------------------------------------------------------------------
export const SHIPMENT_STATUSES = [
  'creando',
  'borrador',
  'etiqueta_lista',
  'en_transito',
  'entregado',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
export type Incident = 'fallo_etiqueta' | 'fallo_transportista';

/** Rango del estado: el envio solo avanza hacia rangos mayores. */
export const rankOf = (s: ShipmentStatus): number => SHIPMENT_STATUSES.indexOf(s);

export const FACT_TYPES = [
  'draft_created',
  'draft_failed',
  'label_ready',
  'in_transit',
  'delivered',
  'label_failed',
  'carrier_failed',
  'tracking_info',
] as const;
export type FactType = (typeof FACT_TYPES)[number];

/** Lo que llega de Packlink (webhook o consulta) o de nuestro propio borrador, ya reducido. */
export type ShipmentFact = {
  readonly type: FactType;
  readonly at: Instant;
  readonly trackingUrl?: string | undefined;
  readonly trackingCode?: string | undefined;
  readonly labelCostCents?: number | undefined;
};

export type ShipmentState = {
  readonly status: ShipmentStatus;
  readonly incident: Incident | undefined;
  /** El borrador fallo y se esta reintentando. */
  readonly draftFailed: boolean;
  readonly lastEventAt: Instant | undefined;
};

export const initialShipmentState: ShipmentState = {
  status: 'creando',
  incident: undefined,
  draftFailed: false,
  lastEventAt: undefined,
};

/** Estado del pedido que corresponde al estado del envio. */
export const orderStatusFor = (s: ShipmentState): OrderStatus => {
  if (s.incident) return 'incidencia';
  switch (s.status) {
    case 'creando':
      return s.draftFailed ? 'error_borrador' : 'pagado';
    case 'borrador':
      return 'borrador_creado';
    case 'etiqueta_lista':
      return 'etiqueta_lista';
    case 'en_transito':
      return 'en_transito';
    case 'entregado':
      return 'entregado';
  }
};

const FORWARD_TARGET: Partial<Record<FactType, ShipmentStatus>> = {
  draft_created: 'borrador',
  label_ready: 'etiqueta_lista',
  in_transit: 'en_transito',
  delivered: 'entregado',
};

const NOTIFICATIONS_FOR: Record<ShipmentStatus, readonly NotificationType[]> = {
  creando: [],
  borrador: ['paga_envio_operador'],
  etiqueta_lista: ['etiqueta_lista_artista'],
  en_transito: ['en_camino_compradora'],
  entregado: ['entregado_compradora', 'entregado_artista'],
};

const EVENT_FOR: Record<ShipmentStatus, OrderEventKind | undefined> = {
  creando: undefined,
  borrador: 'borrador_creado',
  etiqueta_lista: 'etiqueta_lista',
  en_transito: 'en_transito',
  entregado: 'entregado',
};

export type FactResult = {
  readonly state: ShipmentState;
  readonly orderStatus: OrderStatus;
  readonly changed: boolean;
  readonly notifications: readonly NotificationType[];
  readonly eventKind: OrderEventKind | undefined;
};

const unchanged = (state: ShipmentState): FactResult => ({
  state,
  orderStatus: orderStatusFor(state),
  changed: false,
  notifications: [],
  eventKind: undefined,
});

const maxInstant = (a: Instant | undefined, b: Instant): Instant =>
  a === undefined || b > a ? b : a;

/**
 * Funcion pura `aplicar(estado, hecho)`. Reglas:
 *  - Solo hacia delante: un destino de rango igual o menor no cambia nada (idempotente).
 *  - Un hecho del proveedor con instante anterior al ultimo aplicado no cambia nada.
 *  - Fallo de etiqueta o de transportista: `incidencia` desde `borrador`, `etiqueta_lista` o
 *    `en_transito`, una sola vez; un hecho posterior de rango mayor la recupera.
 *  - `draft_failed` solo mientras el envio esta `creando`; `draft_created` lo recupera.
 */
export const applyFact = (state: ShipmentState, fact: ShipmentFact): FactResult => {
  const isOwn = fact.type === 'draft_created' || fact.type === 'draft_failed';
  if (!isOwn && state.lastEventAt !== undefined && fact.at < state.lastEventAt) {
    return unchanged(state);
  }

  if (fact.type === 'tracking_info') return unchanged(state);

  if (fact.type === 'draft_failed') {
    if (state.status !== 'creando' || state.draftFailed || state.incident) return unchanged(state);
    const next: ShipmentState = { ...state, draftFailed: true };
    return {
      state: next,
      orderStatus: orderStatusFor(next),
      changed: true,
      notifications: [],
      eventKind: 'borrador_fallido',
    };
  }

  if (fact.type === 'label_failed' || fact.type === 'carrier_failed') {
    const open = rankOf(state.status) >= 1 && rankOf(state.status) <= 3;
    if (!open || state.incident) return unchanged(state);
    const next: ShipmentState = {
      ...state,
      incident: fact.type === 'label_failed' ? 'fallo_etiqueta' : 'fallo_transportista',
      lastEventAt: maxInstant(state.lastEventAt, fact.at),
    };
    return {
      state: next,
      orderStatus: 'incidencia',
      changed: true,
      notifications: ['incidencia_artista', 'incidencia_compradora', 'incidencia_operador'],
      eventKind: 'incidencia_envio',
    };
  }

  const target = FORWARD_TARGET[fact.type];
  if (target === undefined || rankOf(target) <= rankOf(state.status)) return unchanged(state);
  const next: ShipmentState = {
    status: target,
    incident: undefined, // recuperacion hacia delante
    draftFailed: false,
    lastEventAt: isOwn ? state.lastEventAt : maxInstant(state.lastEventAt, fact.at),
  };
  return {
    state: next,
    orderStatus: orderStatusFor(next),
    changed: true,
    notifications: NOTIFICATIONS_FOR[target],
    eventKind: EVENT_FOR[target],
  };
};

/** Estado del pedido `pagado` que no tiene envio todavia (punto de partida de la cadena). */
export const isShippingChainStatus = (s: OrderStatus): boolean =>
  s === 'pagado' ||
  s === 'error_borrador' ||
  s === 'borrador_creado' ||
  s === 'etiqueta_lista' ||
  s === 'en_transito' ||
  s === 'entregado' ||
  s === 'incidencia';

// ---------------------------------------------------------------------------------------------
// Recogida y puntos de entrega (BR4-RC*, BR4-PT1)
// ---------------------------------------------------------------------------------------------
export type PickupOption = {
  /** Identificador opaco (fecha + franja) que viaja del formulario al borrador. */
  readonly id: string;
  readonly date: string; // YYYY-MM-DD
  readonly slot: string; // p. ej. 09:00-13:00
};

export const choosePickup = (
  options: readonly PickupOption[],
  chosenId: string,
): Result<PickupOption, 'unavailable'> => {
  const found = options.find((o) => o.id === chosenId);
  return found ? ok(found) : err('unavailable');
};

export type DropoffPoint = {
  readonly name: string;
  readonly address: string;
  readonly schedule: string;
  readonly distanceKm: number | undefined;
};

export const MAX_DROPOFFS = 3;

/** Los tres mas cercanos; sin distancia conocida van al final y se conserva su orden (P-U4-11). */
export const selectDropoffs = (points: readonly DropoffPoint[]): DropoffPoint[] =>
  points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const da = a.p.distanceKm ?? Number.POSITIVE_INFINITY;
      const db = b.p.distanceKm ?? Number.POSITIVE_INFINITY;
      return da === db ? a.i - b.i : da - db;
    })
    .slice(0, MAX_DROPOFFS)
    .map((x) => x.p);

// ---------------------------------------------------------------------------------------------
// Tiempos: consulta de respaldo y recordatorios (BR4-EV2, BR4-RC3, BR4-PA2)
// ---------------------------------------------------------------------------------------------
/** Espera hasta la proxima consulta: 15 min el primer dia y 60 min despues. */
export const pollDelayMs = (ageMs: number): number => (ageMs < MS.day ? 15 * MS.minute : MS.hour);

export const PICKUP_REMINDER_MS = 24 * MS.hour;
export const PICKUP_OPERATOR_MS = 72 * MS.hour;
export const PAY_REMINDER_MS = 24 * MS.hour;

export type PickupReminder = 'ninguno' | 'recordatorio' | 'operador';

/** Solo si no se ha elegido; cada aviso una vez (P-U4-12). */
export const pickupReminderDue = (input: {
  chosen: boolean;
  requestedAt: Instant | undefined;
  remindedAt: Instant | undefined;
  operatorAlertedAt: Instant | undefined;
  now: Instant;
}): PickupReminder => {
  if (input.chosen || input.requestedAt === undefined) return 'ninguno';
  const waited = input.now - input.requestedAt;
  if (waited >= PICKUP_OPERATOR_MS && input.operatorAlertedAt === undefined) return 'operador';
  if (waited >= PICKUP_REMINDER_MS && input.remindedAt === undefined) return 'recordatorio';
  return 'ninguno';
};

export const payReminderDue = (input: {
  draftCreatedAt: Instant | undefined;
  remindedAt: Instant | undefined;
  status: ShipmentStatus;
  now: Instant;
}): boolean =>
  input.status === 'borrador' &&
  input.draftCreatedAt !== undefined &&
  input.remindedAt === undefined &&
  input.now - input.draftCreatedAt >= PAY_REMINDER_MS;

// ---------------------------------------------------------------------------------------------
// Margen del envio (BR4-CO1, P-U4-14)
// ---------------------------------------------------------------------------------------------
/** Estimacion de la comision de Stripe por tarjeta europea: 1,5 % + 0,25 €. */
export const estimateStripeFeeCents = (totalCents: number): number =>
  Math.round(totalCents * 0.015) + 25;

export const shippingMarginCents = (input: {
  shippingCents: number;
  labelCostCents: number;
  totalCents: number;
}): number => input.shippingCents - input.labelCostCents - estimateStripeFeeCents(input.totalCents);

// ---------------------------------------------------------------------------------------------
// Siguiente accion de la artista (BR4-SG2, P-U4-18)
// ---------------------------------------------------------------------------------------------
export type NextAction = { readonly code: string; readonly text: string };

export const nextAction = (input: {
  orderStatus: OrderStatus;
  modality: Modality;
  pickupChosen: boolean;
  pickupText?: string | undefined;
}): NextAction => {
  switch (input.orderStatus) {
    case 'pendiente_pago':
      return { code: 'esperando_pago', text: 'Esperando el pago' };
    case 'expirado':
    case 'cancelado':
      return { code: 'cerrado', text: 'Pedido cerrado' };
    case 'reembolsado':
      return { code: 'reembolsado', text: 'Pedido reembolsado' };
    case 'incidencia':
      return { code: 'revisando', text: 'Estamos revisándolo' };
    case 'pagado':
    case 'error_borrador':
    case 'borrador_creado':
      return input.modality === 'recogida' && !input.pickupChosen
        ? { code: 'elegir_recogida', text: 'Elige la recogida' }
        : { code: 'preparando_etiqueta', text: 'Preparando tu etiqueta' };
    case 'etiqueta_lista':
      return input.modality === 'punto'
        ? { code: 'llevar_a_punto', text: 'Lleva el paquete a un punto' }
        : {
            code: 'esperar_recogida',
            text: `Espera la recogida${input.pickupText ? ` el ${input.pickupText}` : ''}`,
          };
    case 'en_transito':
      return { code: 'en_camino', text: 'En camino' };
    case 'entregado':
      return { code: 'entregado', text: 'Entregado' };
    case 'liquidado':
      return { code: 'liquidado', text: 'Entregado y cobrado' };
  }
};

/** Util para pruebas y trabajos: instante a partir de milisegundos. */
export const at = (ms: number): Instant => instantOf(ms);
