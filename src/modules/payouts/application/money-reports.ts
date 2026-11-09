import { addMs, MS, type Clock, type Instant } from '@/modules/kernel/domain/clock';
import { conservationGap } from '@/modules/ledger/domain/ledger';
import type { OperatorAlerts } from '@/modules/orders/application/ports';
import type { OrderStatus } from '@/modules/orders/domain/order';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { Logger } from '@/modules/platform/application/ports';
import { artistScope, systemScope } from '@/modules/platform/application/unit-of-work';
import type { ArtistBalance, Refund, Settlement, Withdrawal } from '../domain/entities';
import type { PayoutMode, SettlementBlock } from '../domain/payouts';
import { staleDelivery } from '../domain/payouts';
import {
  buildMarginReport,
  monthRange,
  previousMonth,
  renderFinanceCsv,
  retentionReason,
  RETAINED_STATUSES,
  type MarginReport,
} from '../domain/reports';
import type { FinanceExportStorage } from './ports';
import type { MoneyRunner } from './settlement';
import type { LedgerEntryRow } from '@/modules/ledger/domain/ledger';

// ---------------------------------------------------------------------------------------------
// Pantalla de dinero de la artista (US-047)
// ---------------------------------------------------------------------------------------------
export type RetainedLine = {
  readonly orderId: string;
  readonly title: string;
  readonly amountCents: number;
  readonly reason: string;
};

export type MoneyOverview = {
  readonly mode: PayoutMode;
  readonly retainedCents: number;
  readonly availableCents: number;
  readonly accountActive: boolean;
  readonly retained: readonly RetainedLine[];
  readonly withdrawals: readonly Withdrawal[];
  readonly movements: readonly LedgerEntryRow[];
  readonly hasOpenWithdrawal: boolean;
};

export class GetMoneyOverview {
  constructor(private readonly deps: { readonly runner: MoneyRunner; readonly mode: PayoutMode }) {}

  async execute(artistId: string): Promise<MoneyOverview> {
    // Contexto de la artista: la RLS solo muestra sus filas (BR5-AZ1).
    return this.deps.runner.run(artistScope(artistId), async (repos) => {
      const [balance, orders, withdrawals, movements, account] = await Promise.all([
        repos.balances.find(artistId),
        repos.orders.listByArtist(artistId, 100),
        repos.withdrawals.listByArtist(artistId, 20),
        repos.ledger.listByArtist(artistId, 50),
        repos.payoutAccounts.find(artistId),
      ]);
      const retained: RetainedLine[] = [];
      for (const o of orders) {
        if (o.paymentMode !== 'stripe' || !RETAINED_STATUSES.includes(o.status)) continue;
        const s = await repos.settlements.findByOrder(o.id);
        const block: SettlementBlock | undefined = s?.blockReason;
        retained.push({
          orderId: o.id,
          title: o.snapshot.title,
          amountCents: s?.amountCents ?? o.workPriceCents - o.commissionCents,
          reason: retentionReason(o.status, block),
        });
      }
      return {
        mode: this.deps.mode,
        retainedCents: balance?.retainedCents ?? 0,
        availableCents: balance?.availableCents ?? 0,
        accountActive: account?.active === true,
        retained,
        withdrawals,
        movements,
        hasOpenWithdrawal: withdrawals.some((w) => w.status === 'solicitada'),
      };
    });
  }
}

/** Dinero de un pedido para el detalle de la artista (liquidacion y reembolsos). */
export type OrderMoney = {
  readonly settlement: Settlement | undefined;
  readonly refunds: readonly Refund[];
  readonly reason: string | undefined;
};

export class GetOrderMoney {
  constructor(private readonly deps: { readonly runner: MoneyRunner }) {}

  async execute(artistId: string, orderId: string, status: OrderStatus): Promise<OrderMoney> {
    return this.deps.runner.run(artistScope(artistId), async (repos) => {
      const settlement = await repos.settlements.findByOrder(orderId);
      const refunds = await repos.refunds.listByOrder(orderId);
      return {
        settlement,
        refunds,
        reason: RETAINED_STATUSES.includes(status)
          ? retentionReason(status, settlement?.blockReason)
          : undefined,
      };
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Conciliacion y recalculo (no corrigen nada: avisan, BR5-LD5)
// ---------------------------------------------------------------------------------------------
type JobDeps = {
  readonly runner: MoneyRunner;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly alerts: OperatorAlerts;
  readonly logger: Logger;
};

const MAX_ALERTS_PER_RUN = 20;

export class ReconcileLedger {
  constructor(private readonly deps: JobDeps) {}

  async execute(correlationId: string): Promise<{ mismatches: number }> {
    const { deps } = this;
    const gaps = await deps.runner.run(systemScope, (r) => r.ledger.orderGaps());
    for (const g of gaps.slice(0, MAX_ALERTS_PER_RUN)) {
      await deps.audit.record({
        actorType: 'system',
        action: 'ledger_mismatch',
        resourceType: 'order',
        resourceId: g.orderId,
        outcome: 'failure',
        correlationId,
        details: { gapCents: g.gapCents },
      });
      await deps.alerts.raise('conciliacion_desajuste', { orderId: g.orderId }, correlationId);
    }
    return { mismatches: gaps.length };
  }
}

export class RecomputeBalances {
  constructor(private readonly deps: JobDeps) {}

  async execute(correlationId: string): Promise<{ mismatches: number }> {
    const { deps } = this;
    const [sums, stored] = await deps.runner.run(systemScope, async (r) =>
      Promise.all([r.ledger.sumsByArtist(), r.balances.listAll()]),
    );
    const byArtist = new Map<string, ArtistBalance>(stored.map((b) => [b.artistId, b]));
    let mismatches = 0;
    for (const s of sums) {
      const b = byArtist.get(s.artistId);
      byArtist.delete(s.artistId);
      if (b && b.retainedCents === s.retainedCents && b.availableCents === s.availableCents)
        continue;
      mismatches += 1;
      if (mismatches > MAX_ALERTS_PER_RUN) continue;
      await deps.audit.record({
        actorType: 'system',
        action: 'balance_mismatch',
        resourceType: 'artist',
        resourceId: s.artistId,
        outcome: 'failure',
        correlationId,
      });
      await deps.alerts.raise(
        'conciliacion_desajuste',
        { detail: `saldo:${s.artistId}` },
        correlationId,
      );
    }
    // Saldos sin movimientos que no son cero tambien son un desajuste.
    for (const b of byArtist.values()) {
      if (b.retainedCents === 0 && b.availableCents === 0) continue;
      mismatches += 1;
      await deps.alerts.raise(
        'conciliacion_desajuste',
        { detail: `saldo:${b.artistId}` },
        correlationId,
      );
    }
    return { mismatches };
  }
}

// ---------------------------------------------------------------------------------------------
// Entrega sin confirmar (BR5-EN1): un solo aviso por pedido
// ---------------------------------------------------------------------------------------------
export class StaleDeliveries {
  constructor(private readonly deps: JobDeps & { readonly staleDays: number }) {}

  async execute(correlationId: string): Promise<{ alerted: number }> {
    const { deps } = this;
    const now = deps.clock.now();
    const before = addMs(now, -deps.staleDays * 24 * MS.hour);
    const candidates = await deps.runner.run(systemScope, (r) =>
      r.orders.listStaleInTransit(before, 50),
    );
    let alerted = 0;
    for (const c of candidates) {
      const raised = await deps.runner.run(systemScope, async (repos) => {
        const order = await repos.orders.findByIdForUpdate(c.id);
        if (!order || !staleDelivery(order.status, order.updatedAt, now, deps.staleDays)) {
          return false;
        }
        const events = await repos.orderEvents.listByOrder(order.id);
        if (events.some((e) => e.kind === 'entrega_sin_confirmar')) return false;
        await repos.orderEvents.append({
          orderId: order.id,
          artistId: order.artistId,
          at: now,
          actor: 'sistema',
          kind: 'entrega_sin_confirmar',
          fromStatus: order.status,
          toStatus: order.status,
          reasonCode: undefined,
          externalRef: undefined,
        });
        return true;
      });
      if (!raised) continue;
      alerted += 1;
      await deps.alerts.raise('entrega_sin_confirmar', { orderId: c.id }, correlationId);
    }
    return { alerted };
  }
}

// ---------------------------------------------------------------------------------------------
// Exportacion contable mensual (Q2 A)
// ---------------------------------------------------------------------------------------------
export class ExportFinance {
  constructor(private readonly deps: JobDeps & { readonly storage: FinanceExportStorage }) {}

  /** Exporta el mes dado (por defecto el anterior). Idempotente: reescribe el mismo fichero. */
  async execute(
    correlationId: string,
    month?: { readonly year: number; readonly month: number },
  ): Promise<{ key: string; rows: number } | { error: string }> {
    const { deps } = this;
    const target = month ?? previousMonth(deps.clock.now());
    const range = monthRange(target.year, target.month);
    const data = await deps.runner.run(systemScope, async (r) => ({
      ledger: await r.ledger.listBetween(range.from, range.to),
      settlements: await r.settlements.listBetween(range.from, range.to),
      withdrawals: await r.withdrawals.listBetween(range.from, range.to),
      refunds: await r.refunds.listBetween(range.from, range.to),
    }));
    const csv = renderFinanceCsv(data);
    const stored = await deps.storage.put(range.key, csv);
    if (!stored.ok) {
      deps.logger.warn('finance_export_failed', { correlationId, key: range.key });
      return { error: stored.error.code };
    }
    await deps.audit.record({
      actorType: 'system',
      action: 'finance_exported',
      resourceType: 'export',
      resourceId: range.key,
      outcome: 'success',
      correlationId,
    });
    return {
      key: range.key,
      rows:
        data.ledger.length +
        data.settlements.length +
        data.withdrawals.length +
        data.refunds.length,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Informe de margen (US-049; la pantalla del operador llega en U6)
// ---------------------------------------------------------------------------------------------
export class GetMarginReport {
  constructor(private readonly deps: { readonly runner: MoneyRunner }) {}

  async execute(from: Instant, to: Instant): Promise<MarginReport> {
    const orders = await this.deps.runner.run(systemScope, (r) =>
      r.orders.listPaidBetween(from, to, 5000),
    );
    return buildMarginReport(orders);
  }
}

/** Comprueba la conservacion sobre una lista de movimientos (utilidad de pruebas y diagnosticos). */
export const ledgerGap = conservationGap;
