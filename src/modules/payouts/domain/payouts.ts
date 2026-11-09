import { err, ok, type Result } from '@/modules/kernel/domain/result';
import { addMs, type Instant } from '@/modules/kernel/domain/clock';
import type { OrderStatus } from '@/modules/orders/domain/order';
import { splitRefund, type Balance, type RefundSplit } from '@/modules/ledger/domain/ledger';

/** Pagos a la artista (U5, PAY): liquidacion, retirada y reembolso. Reglas puras. */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export type PayoutMode = 'manual' | 'automatico';

// ---------------------------------------------------------------------------------------------
// Claves de idempotencia ante el proveedor (BR5-ST3, BR5-WD2, BR5-RF4)
// ---------------------------------------------------------------------------------------------
export const settlementKey = (orderId: string): string => `liquidar:${orderId}`;
export const withdrawalKey = (artistId: string, seq: number): string =>
  `retirar:${artistId}:${seq}`;
export const refundKey = (orderId: string, seq: number): string => `reembolso:${orderId}:${seq}`;

// ---------------------------------------------------------------------------------------------
// Liquidacion
// ---------------------------------------------------------------------------------------------
export type SettlementStatus = 'pendiente' | 'transferida' | 'fallida' | 'anulada';
export type SettlementBlock =
  'cuenta_no_activa' | 'incidencia_abierta' | 'reembolso_en_curso' | 'retraso' | 'sin_cargo';

export type SettlementInput = {
  readonly orderStatus: OrderStatus;
  readonly workCents: number;
  readonly commissionCents: number;
  /** Parte de la artista ya reembolsada. */
  readonly refundedArtistCents: number;
  readonly deliveredAt: Instant | undefined;
  readonly now: Instant;
  readonly delayHours: number;
  readonly accountActive: boolean;
  readonly hasCharge: boolean;
  readonly shipmentIncident: boolean;
  readonly refundPending: boolean;
};

export type SettlementPlan =
  | { readonly action: 'transfer'; readonly amountCents: number }
  | { readonly action: 'wait'; readonly block: SettlementBlock; readonly retryAt: Instant }
  | {
      readonly action: 'none';
      readonly reason: 'not_delivered' | 'already_settled' | 'nothing_to_pay';
    };

/** Pausas de reintento segun la causa de la espera (BR5-ST4, BR5-ST5). */
export const RETRY_ACCOUNT_MS = HOUR_MS;
export const RETRY_BLOCK_MS = 10 * 60_000;

/** Importe a transferir: W - C - parte de la artista reembolsada; nunca mayor que W - C. */
export const settlementAmount = (
  workCents: number,
  commissionCents: number,
  refundedArtistCents: number,
): number =>
  Math.max(
    0,
    Math.min(workCents - commissionCents, workCents - commissionCents - refundedArtistCents),
  );

export const planSettlement = (i: SettlementInput): SettlementPlan => {
  if (i.orderStatus === 'liquidado') return { action: 'none', reason: 'already_settled' };
  if (i.orderStatus !== 'entregado') return { action: 'none', reason: 'not_delivered' };
  const amount = settlementAmount(i.workCents, i.commissionCents, i.refundedArtistCents);
  if (amount <= 0) return { action: 'none', reason: 'nothing_to_pay' };
  if (i.shipmentIncident) {
    return { action: 'wait', block: 'incidencia_abierta', retryAt: addMs(i.now, RETRY_BLOCK_MS) };
  }
  if (i.refundPending) {
    return { action: 'wait', block: 'reembolso_en_curso', retryAt: addMs(i.now, RETRY_BLOCK_MS) };
  }
  if (i.deliveredAt !== undefined) {
    const ready = addMs(i.deliveredAt, Math.max(0, i.delayHours) * HOUR_MS);
    if (ready > i.now) return { action: 'wait', block: 'retraso', retryAt: ready };
  }
  if (!i.hasCharge) {
    return { action: 'wait', block: 'sin_cargo', retryAt: addMs(i.now, RETRY_ACCOUNT_MS) };
  }
  if (!i.accountActive) {
    return { action: 'wait', block: 'cuenta_no_activa', retryAt: addMs(i.now, RETRY_ACCOUNT_MS) };
  }
  return { action: 'transfer', amountCents: amount };
};

/** Aviso al operador si una liquidacion lleva bloqueada mas de N dias (BR5-ST5). */
export const settlementBlockedTooLong = (
  createdAt: Instant,
  now: Instant,
  alertDays: number,
): boolean => now - createdAt >= alertDays * DAY_MS;

// ---------------------------------------------------------------------------------------------
// Entrega sin confirmar (BR5-EN1)
// ---------------------------------------------------------------------------------------------
export const staleDelivery = (
  status: OrderStatus,
  inTransitSince: Instant | undefined,
  now: Instant,
  staleDays: number,
): boolean =>
  status === 'en_transito' &&
  inTransitSince !== undefined &&
  now - inTransitSince >= staleDays * DAY_MS;

/** Liberacion manual: solo desde etiqueta lista o en transito, o incidencia de envio resuelta (BR5-EN2). */
export type ReleaseError = 'not_releasable' | 'refund_in_progress' | 'reason_required';
export const canRelease = (a: {
  readonly status: OrderStatus;
  readonly refundPending: boolean;
  readonly reason: string;
}): Result<true, ReleaseError> => {
  if (a.reason.trim().length === 0) return err('reason_required');
  if (a.refundPending) return err('refund_in_progress');
  if (a.status !== 'etiqueta_lista' && a.status !== 'en_transito') return err('not_releasable');
  return ok(true);
};

// ---------------------------------------------------------------------------------------------
// Retirada
// ---------------------------------------------------------------------------------------------
export type WithdrawalStatus = 'solicitada' | 'enviada' | 'fallida';
export type WithdrawalError = 'automatic_mode' | 'no_balance' | 'login_not_recent' | 'in_progress';

/** Sesion reciente: el acceso con enlace magico no tiene mas de `maxMinutes` (US-048). */
export const isRecentLogin = (
  loginAt: number | undefined,
  now: Instant,
  maxMinutes: number,
): boolean => loginAt !== undefined && loginAt <= now && now - loginAt <= maxMinutes * 60_000;

export const planWithdrawal = (a: {
  readonly mode: PayoutMode;
  readonly balance: Balance;
  readonly hasOpenWithdrawal: boolean;
  readonly loginAt: number | undefined;
  readonly now: Instant;
  readonly recentLoginMinutes: number;
}): Result<{ readonly amountCents: number }, WithdrawalError> => {
  if (a.mode === 'automatico') return err('automatic_mode');
  if (!isRecentLogin(a.loginAt, a.now, a.recentLoginMinutes)) return err('login_not_recent');
  if (a.hasOpenWithdrawal) return err('in_progress');
  if (a.balance.availableCents <= 0) return err('no_balance');
  return ok({ amountCents: a.balance.availableCents });
};

// ---------------------------------------------------------------------------------------------
// Reembolso
// ---------------------------------------------------------------------------------------------
export type RefundStatus = 'solicitado' | 'hecho' | 'fallido';
export type RefundError =
  'invalid_amount' | 'exceeds_remaining' | 'already_settled' | 'not_refundable';

export const REFUND_REASONS = [
  'obra_no_disponible',
  'fallo_envio',
  'error_precio',
  'peticion_compradora',
  'otro',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

const REFUNDABLE: readonly OrderStatus[] = [
  'pagado',
  'error_borrador',
  'borrador_creado',
  'etiqueta_lista',
  'en_transito',
  'entregado',
  'incidencia',
];

export const planRefund = (a: {
  readonly orderStatus: OrderStatus;
  readonly totalCents: number;
  readonly shippingCents: number;
  readonly refundedCents: number;
  readonly refundedShippingCents: number;
  readonly requestCents: number;
}): Result<RefundSplit & { readonly isTotal: boolean }, RefundError> => {
  if (a.orderStatus === 'liquidado') return err('already_settled');
  if (!REFUNDABLE.includes(a.orderStatus)) return err('not_refundable');
  if (!Number.isSafeInteger(a.requestCents) || a.requestCents <= 0) return err('invalid_amount');
  const remaining = a.totalCents - a.refundedCents;
  if (a.requestCents > remaining) return err('exceeds_remaining');
  const split = splitRefund({
    requestCents: a.requestCents,
    shippingCents: a.shippingCents,
    refundedShippingCents: a.refundedShippingCents,
  });
  return ok({ ...split, isTotal: a.requestCents === remaining });
};
