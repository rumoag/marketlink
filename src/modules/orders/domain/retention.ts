import type { Instant } from '@/modules/kernel/domain/clock';
import { instantOf } from '@/modules/kernel/domain/clock';
import type { OrderStatus } from './order';

/**
 * Retencion de datos personales de la compradora (U7, BR7-PD*). Reglas puras: el reloj y los
 * datos externos llegan como parametros.
 */
export type PurgeMode = 'retention' | 'on_demand';

/** Motivos por los que una limpieza espera o se rechaza (conjunto cerrado). */
export type PurgeBlock =
  | 'pedido_sin_pagar'
  | 'cadena_de_envio_activa'
  | 'reembolso_en_curso'
  | 'incidencia_manual_abierta'
  | 'liquidacion_pendiente'
  | 'incidencia_de_envio';

export const PURGE_BLOCK_TEXT: Readonly<Record<PurgeBlock, string>> = {
  pedido_sin_pagar: 'El pedido aún no está pagado: sus datos se borran solos si no se paga.',
  cadena_de_envio_activa:
    'El envío está en curso y los datos hacen falta para entregarlo: reembolsa o espera a la entrega.',
  reembolso_en_curso: 'Hay un reembolso en curso.',
  incidencia_manual_abierta: 'Hay una incidencia abierta: ciérrala primero.',
  liquidacion_pendiente: 'El cobro de la artista aún está pendiente de liquidar.',
  incidencia_de_envio: 'Hay una incidencia de envío sin resolver.',
};

/** Estados de la cadena activa de envio: los datos todavia hacen falta. */
export const ACTIVE_CHAIN: readonly OrderStatus[] = [
  'pagado',
  'error_borrador',
  'borrador_creado',
  'etiqueta_lista',
  'en_transito',
];

/** Estados que gestiona la limpieza de sin pagar de U3 (no la de retencion). */
const UNPAID: readonly OrderStatus[] = ['pendiente_pago', 'expirado', 'cancelado'];

/** Suma meses calendario en UTC (el dia se ajusta al ultimo del mes si hace falta). */
export const addMonthsUtc = (at: number, months: number): Instant => {
  const d = new Date(at);
  const target = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + months,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return instantOf(target.getTime());
};

/** Fecha de referencia: la entrega; si nunca hubo, el pago; y en ultimo caso la creacion. */
export const retentionReference = (input: {
  readonly deliveredAt: Instant | undefined;
  readonly paidAt: Instant | undefined;
  readonly createdAt: Instant;
}): Instant => input.deliveredAt ?? input.paidAt ?? input.createdAt;

/** ¿Venció el plazo? (`months` meses calendario después de la fecha de referencia). */
export const isRetentionDue = (reference: Instant, now: Instant, months: number): boolean =>
  addMonthsUtc(reference, months) <= now;

export type PurgeContext = {
  readonly status: OrderStatus;
  readonly refundPending: boolean;
  readonly manualFlagOpen: boolean;
  readonly settlementPending: boolean;
};

/**
 * ¿Algo retiene la limpieza? `undefined` si puede hacerse. En el modo a peticion se protege
 * ademas la cadena activa de envio y el pedido sin pagar (BR7-PD2, BR7-PD5).
 */
export const purgeBlock = (mode: PurgeMode, c: PurgeContext): PurgeBlock | undefined => {
  if (mode === 'on_demand') {
    if (c.status === 'pendiente_pago') return 'pedido_sin_pagar';
    if (ACTIVE_CHAIN.includes(c.status)) return 'cadena_de_envio_activa';
  }
  if (c.refundPending) return 'reembolso_en_curso';
  if (c.manualFlagOpen) return 'incidencia_manual_abierta';
  if (c.settlementPending) return 'liquidacion_pendiente';
  if (c.status === 'incidencia') return 'incidencia_de_envio';
  return undefined;
};

/** Estados que entran en la limpieza de retencion (los sin pagar los limpia U3 a los 30 dias). */
export const isRetentionStatus = (status: OrderStatus): boolean => !UNPAID.includes(status);
