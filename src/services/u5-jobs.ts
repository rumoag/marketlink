import type { JobHandlerRegistry } from '@/modules/jobs/application/job-queue';
import type {
  ExportFinance,
  ReconcileLedger,
  RecomputeBalances,
  StaleDeliveries,
} from '@/modules/payouts/application/money-reports';
import type { RetrySettlements } from '@/modules/payouts/application/settlement';
import type { ResolveWithdrawals } from '@/modules/payouts/application/withdrawals';

export const JOB_RETRY_SETTLEMENTS = 'retry_settlements';
export const JOB_WITHDRAW_PAYOUT = 'withdraw_payout';
export const JOB_RECONCILE_LEDGER = 'reconcile_ledger';
export const JOB_RECOMPUTE_BALANCES = 'recompute_balances';
export const JOB_STALE_DELIVERIES = 'stale_deliveries';
export const JOB_EXPORT_FINANCE = 'export_finance';

export type U5JobDeps = {
  readonly retrySettlements: Pick<RetrySettlements, 'execute'>;
  readonly resolveWithdrawals: Pick<ResolveWithdrawals, 'execute'>;
  readonly reconcile: Pick<ReconcileLedger, 'execute'>;
  readonly recompute: Pick<RecomputeBalances, 'execute'>;
  readonly stale: Pick<StaleDeliveries, 'execute'>;
  readonly exportFinance: Pick<ExportFinance, 'execute'>;
};

/** Registra los trabajos de dinero de U5. Todos son idempotentes. */
export const registerU5Jobs = (registry: JobHandlerRegistry, deps: U5JobDeps): void => {
  registry.register(JOB_RETRY_SETTLEMENTS, async (_job, ctx) => {
    await deps.retrySettlements.execute(ctx.correlationId);
    return { ok: true };
  });
  registry.register(JOB_WITHDRAW_PAYOUT, async (_job, ctx) => {
    await deps.resolveWithdrawals.execute(ctx.correlationId);
    return { ok: true };
  });
  registry.register(JOB_RECONCILE_LEDGER, async (_job, ctx) => {
    await deps.reconcile.execute(ctx.correlationId);
    return { ok: true };
  });
  registry.register(JOB_RECOMPUTE_BALANCES, async (_job, ctx) => {
    await deps.recompute.execute(ctx.correlationId);
    return { ok: true };
  });
  registry.register(JOB_STALE_DELIVERIES, async (_job, ctx) => {
    await deps.stale.execute(ctx.correlationId);
    return { ok: true };
  });
  registry.register(JOB_EXPORT_FINANCE, async (_job, ctx) => {
    const r = await deps.exportFinance.execute(ctx.correlationId);
    return 'error' in r
      ? { ok: false, error: { retryable: true, message: 'export_finance_failed' } }
      : { ok: true };
  });
};
