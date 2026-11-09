import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { MS, type Instant } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import { ProcessPaymentFact } from '@/modules/orders/application/process-payment-event';
import type { Order } from '@/modules/orders/domain/order';
import { HandleChargeEvent } from '@/modules/payouts/application/charge-events';
import {
  ExportFinance,
  GetMarginReport,
  GetMoneyOverview,
  ReconcileLedger,
  RecomputeBalances,
  StaleDeliveries,
} from '@/modules/payouts/application/money-reports';
import type { FinanceExportStorage, MoneyProvider } from '@/modules/payouts/application/ports';
import { recordPayment } from '@/modules/payouts/application/record-payment';
import { RefundOrder } from '@/modules/payouts/application/refunds';
import {
  registerDelivery,
  ReleaseDelivery,
  RetrySettlements,
  SettleOrder,
} from '@/modules/payouts/application/settlement';
import { RequestWithdrawal, ResolveWithdrawals } from '@/modules/payouts/application/withdrawals';
import {
  applyShipmentFactTx,
  PollShipments,
  ProcessShipmentFact,
} from '@/modules/shipping/application/apply-fact';
import type { AppRepos } from '@/services/repos';
import { factFromEvent } from '@/modules/orders/application/process-payment-event';
import { fact, buildU4, paidOrder, type U4 } from './u4-harness';

export type Failure = 'none' | 'definitive' | 'doubtful';
const fail = (f: Exclude<Failure, 'none'>): AppError =>
  appError(f === 'doubtful' ? 'dependency_unavailable' : 'internal');

/** Stripe simulado en memoria con fallos controlables e idempotencia por clave. */
export class MemoryMoney implements MoneyProvider {
  transfers = new Map<string, { ref: string; orderId: string; amountCents: number }>();
  payouts = new Map<string, { ref: string; amountCents: number }>();
  refunds = new Map<string, { ref: string; amountCents: number }>();
  failTransfer: Failure = 'none';
  failPayout: Failure = 'none';
  failRefund = false;
  /** El primer intento llega al proveedor pero la respuesta se pierde (caso dudoso real). */
  loseFirstPayoutResponse = false;
  noCharge = false;
  method: 'tarjeta' | 'bizum' | undefined = 'tarjeta';
  transferCalls = 0;
  payoutCalls = 0;

  chargeOf(
    pi: string,
  ): Promise<
    Result<{ chargeId: string; method: 'tarjeta' | 'bizum' | undefined } | undefined, AppError>
  > {
    return Promise.resolve(
      ok(this.noCharge ? undefined : { chargeId: `ch_${pi}`, method: this.method }),
    );
  }
  transfer(i: {
    orderId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<Result<{ transferRef: string }, AppError>> {
    this.transferCalls += 1;
    if (this.failTransfer !== 'none') return Promise.resolve(err(fail(this.failTransfer)));
    const prev = this.transfers.get(i.idempotencyKey);
    if (prev) return Promise.resolve(ok({ transferRef: prev.ref }));
    const ref = `tr_${this.transfers.size + 1}`;
    this.transfers.set(i.idempotencyKey, { ref, orderId: i.orderId, amountCents: i.amountCents });
    return Promise.resolve(ok({ transferRef: ref }));
  }
  findTransfer(orderId: string): Promise<Result<{ transferRef: string } | undefined, AppError>> {
    const f = [...this.transfers.values()].find((t) => t.orderId === orderId);
    return Promise.resolve(ok(f ? { transferRef: f.ref } : undefined));
  }
  payout(i: {
    amountCents: number;
    idempotencyKey: string;
  }): Promise<Result<{ payoutRef: string }, AppError>> {
    this.payoutCalls += 1;
    if (this.failPayout !== 'none') return Promise.resolve(err(fail(this.failPayout)));
    let p = this.payouts.get(i.idempotencyKey);
    if (!p) {
      p = { ref: `po_${this.payouts.size + 1}`, amountCents: i.amountCents };
      this.payouts.set(i.idempotencyKey, p);
    }
    if (this.loseFirstPayoutResponse) {
      this.loseFirstPayoutResponse = false;
      return Promise.resolve(err(fail('doubtful')));
    }
    return Promise.resolve(ok({ payoutRef: p.ref }));
  }
  findPayout(
    _a: string,
    key: string,
  ): Promise<Result<{ payoutRef: string } | undefined, AppError>> {
    const p = this.payouts.get(key);
    return Promise.resolve(ok(p ? { payoutRef: p.ref } : undefined));
  }
  refund(i: {
    amountCents: number;
    idempotencyKey: string;
  }): Promise<Result<{ refundRef: string }, AppError>> {
    if (this.failRefund) return Promise.resolve(err(appError('dependency_unavailable')));
    const prev = this.refunds.get(i.idempotencyKey);
    if (prev) return Promise.resolve(ok({ refundRef: prev.ref }));
    const ref = `re_${this.refunds.size + 1}`;
    this.refunds.set(i.idempotencyKey, { ref, amountCents: i.amountCents });
    return Promise.resolve(ok({ refundRef: ref }));
  }
}

export class MemoryExports implements FinanceExportStorage {
  files = new Map<string, string>();
  failing = false;
  put(key: string, csv: string): Promise<Result<void, AppError>> {
    if (this.failing) return Promise.resolve(err(appError('dependency_unavailable')));
    this.files.set(key, csv);
    return Promise.resolve(ok(undefined));
  }
}

export const buildU5 = (options: { mode?: 'manual' | 'automatico'; delayHours?: number } = {}) => {
  const u4 = buildU4();
  const { db, clock, ids, audit, alerts, logger } = u4;
  const money = new MemoryMoney();
  const exportsStorage = new MemoryExports();

  const onDelivered = (repos: unknown, order: Order, now: Instant): Promise<void> =>
    registerDelivery(repos as AppRepos, ids, order, now);
  const processor = new ProcessPaymentFact({
    runner: db,
    clock,
    audit,
    alerts,
    logger,
    provider: u4.payments,
    inTxPaid: (repos, order, now) => recordPayment(repos as AppRepos, order, now),
  });
  const processFact = new ProcessShipmentFact({
    runner: db,
    provider: u4.provider,
    storage: u4.labels,
    alerts,
    clock,
    ids,
    logger,
    onDelivered,
  });
  const poll = new PollShipments({
    runner: db,
    provider: u4.provider,
    processor: processFact,
    clock,
  });

  const mode = options.mode ?? 'manual';
  const base = { runner: db, clock, ids, audit, alerts, logger };
  const settle = new SettleOrder({
    ...base,
    provider: money,
    settlementDelayHours: options.delayHours ?? 0,
    blockedAlertDays: 7,
  });
  const retry = new RetrySettlements({
    ...base,
    provider: money,
    settlementDelayHours: options.delayHours ?? 0,
    blockedAlertDays: 7,
    settle,
  });
  const wdDeps = {
    ...base,
    provider: money,
    mode,
    recentLoginMinutes: 15,
    limiter: u4.limiter,
  };
  const withdraw = new RequestWithdrawal(wdDeps);
  const resolveWithdrawals = new ResolveWithdrawals({ ...wdDeps, requests: withdraw });
  const refundOrder = new RefundOrder({ ...base, provider: money });
  const release = new ReleaseDelivery({
    ...base,
    provider: money,
    settlementDelayHours: options.delayHours ?? 0,
    blockedAlertDays: 7,
    settle,
    markDelivered: async (repos, order, now) => {
      const r = repos as AppRepos;
      const shipment = await r.shipments.findByOrderForUpdate(order.id);
      if (!shipment) return 'unchanged';
      const applied = await applyShipmentFactTx(
        r,
        ids,
        order,
        shipment,
        { type: 'delivered', at: now },
        now,
        onDelivered,
      );
      return applied.order.status === 'entregado' ? 'delivered' : 'unchanged';
    },
  });
  const jobDeps = { runner: db, clock, audit, alerts, logger };

  return {
    ...u4,
    processor,
    processFact,
    poll,
    money,
    exportsStorage,
    settle,
    retry,
    withdraw,
    resolveWithdrawals,
    refundOrder,
    release,
    overview: new GetMoneyOverview({ runner: db, mode }),
    reconcile: new ReconcileLedger(jobDeps),
    recompute: new RecomputeBalances(jobDeps),
    stale: new StaleDeliveries({ ...jobDeps, staleDays: 10 }),
    exportFinance: new ExportFinance({ ...jobDeps, storage: exportsStorage }),
    margin: new GetMarginReport({ runner: db }),
    charge: new HandleChargeEvent({ runner: db, audit, alerts }),
  };
};
export type U5 = ReturnType<typeof buildU5>;

/** Compra pagada (con retencion en el libro) y envio con borrador, listo para recibir hechos. */
export const paidU5Order = async (u: U5) => {
  const r = await paidOrder(u as unknown as U4);
  const rec = u.db.state.payouts.get(r.artistId);
  if (rec && rec.providerAccountId === undefined) {
    u.db.state.payouts.set(r.artistId, { ...rec, providerAccountId: 'acct_test' });
  }
  return r;
};

/** Lleva el pedido pagado hasta `entregado` con hechos de transporte reales. */
export const deliver = async (u: U5, orderId: string): Promise<void> => {
  await u.draft.execute(orderId, 'c', false);
  const ship = [...u.db.state.shipments.values()].find((s) => s.orderId === orderId);
  const ref = ship?.providerRef as string;
  const t = u.clock.now();
  await u.processFact.execute(ref, fact('label_ready', t), 'c');
  await u.processFact.execute(ref, fact('in_transit', t + 1), 'c');
  await u.processFact.execute(ref, fact('delivered', t + 2), 'c');
};

export const minutes = (n: number): number => n * MS.minute;
export { factFromEvent };
