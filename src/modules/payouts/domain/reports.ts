import type { Order, OrderStatus } from '@/modules/orders/domain/order';
import { estimateStripeFeeCents } from '@/modules/shipping/domain/shipment';
import type { Instant } from '@/modules/kernel/domain/clock';
import type { LedgerEntryRow } from '@/modules/ledger/domain/ledger';
import type { Refund, Settlement, Withdrawal } from './entities';
import type { SettlementBlock } from './payouts';

// ---------------------------------------------------------------------------------------------
// «En retencion» explicado por pedido (BR5-LD6)
// ---------------------------------------------------------------------------------------------
export const retentionReason = (
  status: OrderStatus,
  block: SettlementBlock | undefined,
): string => {
  switch (status) {
    case 'entregado':
      return block === 'cuenta_no_activa'
        ? 'Pendiente de que actives tus cobros'
        : 'Entregado, liquidando';
    case 'en_transito':
      return 'En camino';
    case 'incidencia':
      return 'Estamos revisando el envío';
    default:
      return 'Esperando la etiqueta';
  }
};

/** Estados en los que el dinero de la obra sigue retenido. */
export const RETAINED_STATUSES: readonly OrderStatus[] = [
  'pagado',
  'error_borrador',
  'borrador_creado',
  'etiqueta_lista',
  'en_transito',
  'entregado',
  'incidencia',
];

// ---------------------------------------------------------------------------------------------
// Informe de margen (BR5-MG1, P-U5-15)
// ---------------------------------------------------------------------------------------------
export type MarginLine = {
  readonly orderId: string;
  readonly totalCents: number;
  readonly shippingCents: number;
  readonly labelCostCents: number | undefined;
  readonly stripeFeeCents: number;
  readonly marginCents: number | undefined;
};

export type MarginReport = {
  readonly orders: number;
  readonly totalCents: number;
  readonly shippingCents: number;
  readonly labelCostCents: number;
  readonly stripeFeeCents: number;
  readonly marginCents: number;
  readonly negativeMarginOrders: number;
  readonly withoutLabelCost: number;
  readonly lines: readonly MarginLine[];
};

export const buildMarginReport = (orders: readonly Order[]): MarginReport => {
  const lines: MarginLine[] = orders.map((o) => ({
    orderId: o.id,
    totalCents: o.totalCents,
    shippingCents: o.shippingCents,
    labelCostCents: o.labelCostCents,
    stripeFeeCents: estimateStripeFeeCents(o.totalCents),
    marginCents: o.marginCents,
  }));
  let margin = 0;
  let labels = 0;
  let negative = 0;
  let missing = 0;
  for (const l of lines) {
    if (l.marginCents === undefined || l.labelCostCents === undefined) {
      missing += 1;
      continue;
    }
    margin += l.marginCents;
    labels += l.labelCostCents;
    if (l.marginCents < 0) negative += 1;
  }
  return {
    orders: lines.length,
    totalCents: lines.reduce((s, l) => s + l.totalCents, 0),
    shippingCents: lines.reduce((s, l) => s + l.shippingCents, 0),
    labelCostCents: labels,
    stripeFeeCents: lines.reduce((s, l) => s + l.stripeFeeCents, 0),
    marginCents: margin,
    negativeMarginOrders: negative,
    withoutLabelCost: missing,
    lines,
  };
};

// ---------------------------------------------------------------------------------------------
// Exportacion contable mensual en CSV (sin datos personales)
// ---------------------------------------------------------------------------------------------
export const FINANCE_CSV_HEADER =
  'tipo,fecha,pedido,artista,clase,cubo,importe_centimos,importe_eur,referencia,estado';

const eurDecimal = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/** Evita la inyeccion de formulas en hojas de calculo y escapa comillas y comas. */
export const csvCell = (value: string | number | undefined): string => {
  if (value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && typeof value === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const iso = (t: Instant): string => new Date(t).toISOString();

export const renderFinanceCsv = (input: {
  readonly ledger: readonly LedgerEntryRow[];
  readonly settlements: readonly Settlement[];
  readonly withdrawals: readonly Withdrawal[];
  readonly refunds: readonly Refund[];
}): string => {
  const rows: string[] = [FINANCE_CSV_HEADER];
  const row = (cells: (string | number | undefined)[]): void => {
    rows.push(cells.map(csvCell).join(','));
  };
  for (const e of input.ledger) {
    row([
      'libro',
      iso(e.at),
      e.orderId,
      e.artistId,
      e.kind,
      e.bucket,
      e.deltaCents,
      eurDecimal(e.deltaCents),
      e.ref,
      e.reasonCode,
    ]);
  }
  for (const s of input.settlements) {
    row([
      'liquidacion',
      iso(s.createdAt),
      s.orderId,
      s.artistId,
      '',
      '',
      s.amountCents,
      eurDecimal(s.amountCents),
      s.transferRef,
      s.status,
    ]);
  }
  for (const w of input.withdrawals) {
    row([
      'retirada',
      iso(w.createdAt),
      '',
      w.artistId,
      '',
      '',
      w.amountCents,
      eurDecimal(w.amountCents),
      w.payoutRef,
      w.status,
    ]);
  }
  for (const r of input.refunds) {
    row([
      'reembolso',
      iso(r.createdAt),
      r.orderId,
      '',
      '',
      '',
      r.amountCents,
      eurDecimal(r.amountCents),
      r.refundRef,
      r.status,
    ]);
  }
  return `${rows.join('\n')}\n`;
};

/** Clave del fichero de un mes (`YYYY-MM.csv`) y sus limites UTC. */
export const monthRange = (
  year: number,
  month: number,
): { readonly key: string; readonly from: Instant; readonly to: Instant } => ({
  key: `${year}-${String(month).padStart(2, '0')}.csv`,
  from: Date.UTC(year, month - 1, 1) as Instant,
  to: Date.UTC(year, month, 1) as Instant,
});

/** Mes anterior al instante dado (UTC). */
export const previousMonth = (now: Instant): { year: number; month: number } => {
  const d = new Date(now);
  const m = d.getUTCMonth();
  return m === 0
    ? { year: d.getUTCFullYear() - 1, month: 12 }
    : { year: d.getUTCFullYear(), month: m };
};
