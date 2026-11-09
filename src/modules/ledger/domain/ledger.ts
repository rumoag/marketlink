import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { Instant } from '@/modules/kernel/domain/clock';

/**
 * Libro de dinero (U5, LED). Importes en centimos enteros. El libro es de solo insercion: los
 * saldos se derivan de el y nunca se editan (BR5-LD1). Sin datos personales (BR5-PV1).
 */
export const LEDGER_KINDS = [
  'cobro',
  'retencion',
  'envio_plataforma',
  'comision',
  'liquidacion',
  'retirada',
  'reembolso',
  'ajuste',
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const LEDGER_BUCKETS = ['stripe', 'retenido', 'disponible', 'plataforma'] as const;
export type LedgerBucket = (typeof LEDGER_BUCKETS)[number];

export type LedgerEntry = {
  readonly orderId: string | undefined;
  readonly artistId: string | undefined;
  readonly kind: LedgerKind;
  readonly bucket: LedgerBucket;
  /** Variacion con signo en el cubo; entero distinto de cero. */
  readonly deltaCents: number;
  /** Referencia opaca del proveedor o del trabajo. */
  readonly ref: string | undefined;
  readonly reasonCode: string | undefined;
  /** Clave de idempotencia de la escritura: la misma clave inserta el movimiento una sola vez. */
  readonly entryKey: string;
};

export type LedgerEntryRow = LedgerEntry & { readonly at: Instant };

export type Balance = { readonly retainedCents: number; readonly availableCents: number };
export const EMPTY_BALANCE: Balance = { retainedCents: 0, availableCents: 0 };

export type LedgerError = 'invalid_amount' | 'negative_balance';

const isCents = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/**
 * Aplica movimientos a un saldo de artista. Solo cuentan los cubos `retenido` y `disponible`.
 * Si algun cubo quedaria negativo (en cualquier punto intermedio) se rechaza todo (BR5-LD3).
 */
export const applyEntries = (
  balance: Balance,
  entries: readonly Pick<LedgerEntry, 'bucket' | 'deltaCents'>[],
): Result<Balance, LedgerError> => {
  let retained = balance.retainedCents;
  let available = balance.availableCents;
  for (const e of entries) {
    if (!Number.isSafeInteger(e.deltaCents) || e.deltaCents === 0) return err('invalid_amount');
    if (e.bucket === 'retenido') retained += e.deltaCents;
    else if (e.bucket === 'disponible') available += e.deltaCents;
    if (retained < 0 || available < 0) return err('negative_balance');
    if (!Number.isSafeInteger(retained) || !Number.isSafeInteger(available)) {
      return err('invalid_amount');
    }
  }
  return ok({ retainedCents: retained, availableCents: available });
};

/** Saldo de una artista a partir de todos sus movimientos (recalculo y conciliacion). */
export const balanceOf = (
  entries: readonly Pick<LedgerEntry, 'bucket' | 'deltaCents'>[],
): Result<Balance, LedgerError> => applyEntries(EMPTY_BALANCE, entries);

// ---------------------------------------------------------------------------------------------
// Claves de idempotencia de los movimientos
// ---------------------------------------------------------------------------------------------
export const paymentEntryKey = (orderId: string, kind: LedgerKind): string =>
  `pago:${orderId}:${kind}`;
export const settlementEntryKey = (orderId: string, bucket: LedgerBucket): string =>
  `liquidacion:${orderId}:${bucket}`;
export const withdrawalEntryKey = (artistId: string, seq: number): string =>
  `retirada:${artistId}:${seq}`;
export const withdrawalReversalKey = (artistId: string, seq: number): string =>
  `retirada-revertida:${artistId}:${seq}`;
export const refundEntryKey = (orderId: string, seq: number, bucket: LedgerBucket): string =>
  `reembolso:${orderId}:${seq}:${bucket}`;

// ---------------------------------------------------------------------------------------------
// Retencion al pagar (BR5-LD2)
// ---------------------------------------------------------------------------------------------
export type PaymentAmounts = {
  readonly orderId: string;
  readonly artistId: string;
  readonly workCents: number;
  readonly shippingCents: number;
  readonly commissionCents: number;
  readonly ref?: string | undefined;
};

/**
 * Movimientos al confirmarse el pago: cobro (+T en stripe), retencion (+(W-C) en retenido),
 * envio (+E en plataforma) y comision (+C en plataforma, solo si C > 0). T = W + E.
 */
export const planPayment = (a: PaymentAmounts): Result<readonly LedgerEntry[], LedgerError> => {
  if (!isCents(a.workCents) || !isCents(a.shippingCents) || !isCents(a.commissionCents)) {
    return err('invalid_amount');
  }
  if (a.commissionCents > a.workCents) return err('invalid_amount');
  const total = a.workCents + a.shippingCents;
  const base = { orderId: a.orderId, ref: a.ref, reasonCode: 'pago_confirmado' } as const;
  const entries: LedgerEntry[] = [];
  if (total > 0) {
    entries.push({
      ...base,
      artistId: undefined,
      kind: 'cobro',
      bucket: 'stripe',
      deltaCents: total,
      entryKey: paymentEntryKey(a.orderId, 'cobro'),
    });
  }
  const retained = a.workCents - a.commissionCents;
  if (retained > 0) {
    entries.push({
      ...base,
      artistId: a.artistId,
      kind: 'retencion',
      bucket: 'retenido',
      deltaCents: retained,
      entryKey: paymentEntryKey(a.orderId, 'retencion'),
    });
  }
  if (a.shippingCents > 0) {
    entries.push({
      ...base,
      artistId: undefined,
      kind: 'envio_plataforma',
      bucket: 'plataforma',
      deltaCents: a.shippingCents,
      entryKey: paymentEntryKey(a.orderId, 'envio_plataforma'),
    });
  }
  if (a.commissionCents > 0) {
    entries.push({
      ...base,
      artistId: undefined,
      kind: 'comision',
      bucket: 'plataforma',
      deltaCents: a.commissionCents,
      entryKey: paymentEntryKey(a.orderId, 'comision'),
    });
  }
  return ok(entries);
};

// ---------------------------------------------------------------------------------------------
// Liquidacion: retenido -> disponible (BR5-ST2)
// ---------------------------------------------------------------------------------------------
export const planSettlementEntries = (a: {
  readonly orderId: string;
  readonly artistId: string;
  readonly amountCents: number;
  readonly ref?: string | undefined;
  readonly reasonCode: string;
}): Result<readonly LedgerEntry[], LedgerError> => {
  if (!Number.isSafeInteger(a.amountCents) || a.amountCents <= 0) return err('invalid_amount');
  const base = {
    orderId: a.orderId,
    artistId: a.artistId,
    kind: 'liquidacion',
    ref: a.ref,
    reasonCode: a.reasonCode,
  } as const;
  return ok([
    {
      ...base,
      bucket: 'retenido',
      deltaCents: -a.amountCents,
      entryKey: settlementEntryKey(a.orderId, 'retenido'),
    },
    {
      ...base,
      bucket: 'disponible',
      deltaCents: a.amountCents,
      entryKey: settlementEntryKey(a.orderId, 'disponible'),
    },
  ]);
};

// ---------------------------------------------------------------------------------------------
// Reembolso: stripe -R, plataforma -envio, retenido -artista (BR5-RF2)
// ---------------------------------------------------------------------------------------------
export type RefundSplit = { readonly shippingPartCents: number; readonly artistPartCents: number };

/**
 * Reparto del reembolso `R`: primero la parte del envio que aun no se ha devuelto y el resto de
 * la parte de la artista. `shippingPart + artistPart = R`.
 */
export const splitRefund = (a: {
  readonly requestCents: number;
  readonly shippingCents: number;
  readonly refundedShippingCents: number;
}): RefundSplit => {
  const room = Math.max(0, a.shippingCents - a.refundedShippingCents);
  const shippingPartCents = Math.min(a.requestCents, room);
  return { shippingPartCents, artistPartCents: a.requestCents - shippingPartCents };
};

export const planRefundEntries = (a: {
  readonly orderId: string;
  readonly artistId: string;
  readonly seq: number;
  readonly split: RefundSplit;
  readonly ref?: string | undefined;
}): Result<readonly LedgerEntry[], LedgerError> => {
  const { shippingPartCents: s, artistPartCents: p } = a.split;
  if (!isCents(s) || !isCents(p) || s + p === 0) return err('invalid_amount');
  const base = {
    orderId: a.orderId,
    kind: 'reembolso',
    ref: a.ref,
    reasonCode: 'reembolso',
  } as const;
  const entries: LedgerEntry[] = [
    {
      ...base,
      artistId: undefined,
      bucket: 'stripe',
      deltaCents: -(s + p),
      entryKey: refundEntryKey(a.orderId, a.seq, 'stripe'),
    },
  ];
  if (s > 0) {
    entries.push({
      ...base,
      artistId: undefined,
      bucket: 'plataforma',
      deltaCents: -s,
      entryKey: refundEntryKey(a.orderId, a.seq, 'plataforma'),
    });
  }
  if (p > 0) {
    entries.push({
      ...base,
      artistId: a.artistId,
      bucket: 'retenido',
      deltaCents: -p,
      entryKey: refundEntryKey(a.orderId, a.seq, 'retenido'),
    });
  }
  return ok(entries);
};

// ---------------------------------------------------------------------------------------------
// Retirada y su reversion
// ---------------------------------------------------------------------------------------------
export const planWithdrawalEntry = (a: {
  readonly artistId: string;
  readonly seq: number;
  readonly amountCents: number;
}): Result<LedgerEntry, LedgerError> => {
  if (!Number.isSafeInteger(a.amountCents) || a.amountCents <= 0) return err('invalid_amount');
  return ok({
    orderId: undefined,
    artistId: a.artistId,
    kind: 'retirada',
    bucket: 'disponible',
    deltaCents: -a.amountCents,
    ref: undefined,
    reasonCode: 'retirada_solicitada',
    entryKey: withdrawalEntryKey(a.artistId, a.seq),
  });
};

export const planWithdrawalReversal = (a: {
  readonly artistId: string;
  readonly seq: number;
  readonly amountCents: number;
}): Result<LedgerEntry, LedgerError> => {
  if (!Number.isSafeInteger(a.amountCents) || a.amountCents <= 0) return err('invalid_amount');
  return ok({
    orderId: undefined,
    artistId: a.artistId,
    kind: 'ajuste',
    bucket: 'disponible',
    deltaCents: a.amountCents,
    ref: undefined,
    reasonCode: 'retirada_fallida',
    entryKey: withdrawalReversalKey(a.artistId, a.seq),
  });
};

// ---------------------------------------------------------------------------------------------
// Conservacion (BR5-LD4)
// ---------------------------------------------------------------------------------------------
/**
 * Regla de conservacion sobre un conjunto de movimientos: lo cobrado en `stripe` es igual a lo
 * repartido entre retenido, disponible y plataforma mas lo ya retirado (neto de reversiones).
 * Devuelve 0 si se cumple; si no, la diferencia.
 */
export const conservationGap = (
  entries: readonly Pick<LedgerEntry, 'bucket' | 'kind' | 'deltaCents'>[],
): number => {
  let stripe = 0;
  let others = 0;
  let withdrawnNet = 0;
  for (const e of entries) {
    if (e.bucket === 'stripe') stripe += e.deltaCents;
    else others += e.deltaCents;
    if (e.kind === 'retirada') withdrawnNet -= e.deltaCents;
    if (e.kind === 'ajuste') withdrawnNet -= e.deltaCents;
  }
  return stripe - (others + withdrawnNet);
};
