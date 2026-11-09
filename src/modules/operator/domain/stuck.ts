import type { OrderStatus } from '@/modules/orders/domain/order';
import { DAY_MS, HOUR_MS } from '@/modules/payouts/domain/payouts';

/** Motivos por los que un pedido se destaca como atascado (BR6-PD2), por orden de prioridad. */
export const STUCK_REASONS = [
  'incidencia_manual',
  'error_borrador',
  'borrador_sin_pagar',
  'recogida_sin_elegir',
  'entrega_sin_confirmar',
  'liquidacion_bloqueada',
] as const;
export type StuckReason = (typeof STUCK_REASONS)[number];

export const STUCK_TEXT: Readonly<Record<StuckReason, string>> = {
  incidencia_manual: 'Incidencia abierta por el operador',
  error_borrador: 'El borrador de envío ha fallado',
  borrador_sin_pagar: 'Borrador sin pagar en Packlink desde hace más de 24 horas',
  recogida_sin_elegir: 'La artista lleva más de 72 horas sin elegir la recogida',
  entrega_sin_confirmar: 'Lleva demasiado tiempo en tránsito sin entrega confirmada',
  liquidacion_bloqueada: 'El cobro de la artista está bloqueado',
};

export const DRAFT_UNPAID_MS = 24 * HOUR_MS;
export const PICKUP_UNCHOSEN_MS = 72 * HOUR_MS;

/** Lo mínimo de una fila de pedido para decidir si está atascada. */
export type StuckInput = {
  readonly status: OrderStatus;
  /** Última actualización del pedido (aproxima «desde cuándo está en tránsito»). */
  readonly updatedAt: number;
  readonly manualFlagOpen: boolean;
  readonly shipmentStatus:
    'creando' | 'borrador' | 'etiqueta_lista' | 'en_transito' | 'entregado' | undefined;
  readonly draftCreatedAt: number | undefined;
  readonly pickupChosen: boolean;
  readonly pickupRequestedAt: number | undefined;
  /** Liquidación pendiente con motivo de bloqueo. */
  readonly settlementBlocked: boolean;
};

/** Función pura (P-U6-07): el primer motivo que aplica, o `undefined` si no está atascado. */
export const stuckReason = (
  i: StuckInput,
  nowMs: number,
  staleDays: number,
): StuckReason | undefined => {
  if (i.manualFlagOpen) return 'incidencia_manual';
  if (i.status === 'error_borrador') return 'error_borrador';
  if (
    i.shipmentStatus === 'borrador' &&
    i.draftCreatedAt !== undefined &&
    nowMs - i.draftCreatedAt >= DRAFT_UNPAID_MS
  ) {
    return 'borrador_sin_pagar';
  }
  if (
    i.shipmentStatus === 'creando' &&
    !i.pickupChosen &&
    i.pickupRequestedAt !== undefined &&
    nowMs - i.pickupRequestedAt >= PICKUP_UNCHOSEN_MS
  ) {
    return 'recogida_sin_elegir';
  }
  if (i.status === 'en_transito' && nowMs - i.updatedAt >= staleDays * DAY_MS) {
    return 'entrega_sin_confirmar';
  }
  if (i.settlementBlocked) return 'liquidacion_bloqueada';
  return undefined;
};

/** Dirección de la lista de envíos de Packlink PRO (la dirección profunda no está verificada). */
export const packlinkShipmentsUrl = (): string => 'https://pro.packlink.es/private/shipments';
