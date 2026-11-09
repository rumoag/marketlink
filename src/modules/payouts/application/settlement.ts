import { addMs, MS, type Clock, type Instant } from '@/modules/kernel/domain/clock';
import { planSettlementEntries } from '@/modules/ledger/domain/ledger';
import { recipientOf } from '@/modules/notifications/domain/notification';
import { applyOrderTrigger } from '@/modules/orders/application/apply-trigger';
import type { OperatorAlerts } from '@/modules/orders/application/ports';
import type { Order } from '@/modules/orders/domain/order';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { IdGenerator, Logger } from '@/modules/platform/application/ports';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import type { Settlement } from '../domain/entities';
import {
  canRelease,
  planSettlement,
  settlementAmount,
  settlementBlockedTooLong,
  settlementKey,
} from '../domain/payouts';
import { MoneyInvariantError, postEntries } from './post-entries';
import type { MoneyProvider, PayoutsRepos } from './ports';

export type MoneyRunner = TransactionRunner<PayoutsRepos>;

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1, 5, 15, 60, 240].map((m) => m * MS.minute);
const LEASE_MS = 5 * MS.minute;
const BATCH = 20;

/**
 * Gancho de entrega (BR5-ST1): dentro de la transaccion que deja el pedido en `entregado` se crea
 * la liquidacion pendiente (bandeja de salida). Los cobros manuales (Bizum a la artista) no pasan
 * por la plataforma y no se liquidan. Idempotente: una liquidacion por pedido.
 */
export const registerDelivery = async (
  repos: Pick<PayoutsRepos, 'settlements'>,
  ids: IdGenerator,
  order: Order,
  now: Instant,
): Promise<void> => {
  if (order.paymentMode !== 'stripe') return;
  await repos.settlements.insertIfAbsent({
    id: ids.uuid(),
    orderId: order.id,
    artistId: order.artistId,
    amountCents: settlementAmount(order.workPriceCents, order.commissionCents, 0),
    status: 'pendiente',
    blockReason: undefined,
    transferRef: undefined,
    attempts: 0,
    nextAttemptAt: now,
    releasedBy: undefined,
    alertedAt: undefined,
    createdAt: now,
    completedAt: undefined,
    updatedAt: now,
  });
};

export type SettleDeps = {
  readonly runner: MoneyRunner;
  readonly provider: Pick<MoneyProvider, 'chargeOf' | 'transfer' | 'findTransfer'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly audit: AuditLog;
  readonly alerts: OperatorAlerts;
  readonly logger: Logger;
  readonly settlementDelayHours: number;
  readonly blockedAlertDays: number;
};

export type SettleOutcome =
  | { readonly kind: 'transferred'; readonly amountCents: number }
  | { readonly kind: 'waiting'; readonly reason: string }
  | { readonly kind: 'noop' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'failed' };

type Plan =
  | { readonly kind: 'done'; readonly outcome: SettleOutcome }
  | {
      readonly kind: 'transfer';
      readonly accountId: string;
      readonly chargeId: string;
      readonly amountCents: number;
    };

export class SettleOrder {
  constructor(private readonly deps: SettleDeps) {}

  async execute(orderId: string, correlationId: string): Promise<SettleOutcome> {
    const { deps } = this;
    // 1) Cobro del pago: se resuelve fuera de la transaccion y se guarda en el pedido.
    const known = await deps.runner.run(systemScope, (r) => r.orders.findById(orderId));
    if (!known) return { kind: 'noop' };
    let fetchedCharge: string | undefined;
    let fetchedMethod: 'tarjeta' | 'bizum' | undefined;
    if (
      (known.chargeId === undefined || known.paymentMethod === undefined) &&
      known.paymentIntentId !== undefined
    ) {
      const c = await deps.provider.chargeOf(known.paymentIntentId);
      if (c.ok && c.value) {
        fetchedCharge = c.value.chargeId;
        fetchedMethod = c.value.method;
      }
    }

    // 2) Decision con el pedido bloqueado.
    const plan = await deps.runner.run(systemScope, async (repos): Promise<Plan> => {
      const now = deps.clock.now();
      const order = await repos.orders.findByIdForUpdate(orderId);
      const settlement = await repos.settlements.findByOrderForUpdate(orderId);
      if (!order || !settlement) return { kind: 'done', outcome: { kind: 'noop' } };
      if (settlement.status === 'transferida' || order.status === 'liquidado') {
        return { kind: 'done', outcome: { kind: 'noop' } };
      }
      let current = order;
      const chargeId = order.chargeId ?? fetchedCharge;
      if (
        (order.chargeId === undefined && fetchedCharge !== undefined) ||
        (order.paymentMethod === undefined && fetchedMethod !== undefined)
      ) {
        current = {
          ...order,
          chargeId: order.chargeId ?? fetchedCharge,
          paymentMethod: order.paymentMethod ?? fetchedMethod,
          version: order.version + 1,
          updatedAt: now,
        };
        if (!(await repos.orders.save(current))) throw new Error('concurrent_order_update');
      }
      const refunds = await repos.refunds.listByOrder(orderId);
      const refundedArtist = refunds
        .filter((x) => x.status === 'hecho')
        .reduce((sum, x) => sum + x.artistPartCents, 0);
      const account = await repos.payoutAccounts.find(order.artistId);
      const decision = planSettlement({
        orderStatus: current.status,
        workCents: current.workPriceCents,
        commissionCents: current.commissionCents,
        refundedArtistCents: refundedArtist,
        deliveredAt: settlement.createdAt,
        now,
        delayHours: deps.settlementDelayHours,
        accountActive: account?.active === true && account.providerAccountId !== undefined,
        hasCharge: chargeId !== undefined,
        shipmentIncident: await repos.manualFlags.hasOpen(orderId),
        refundPending: refunds.some((x) => x.status === 'solicitado'),
      });
      if (decision.action === 'none') {
        // Nada que pagar (reembolso total) o pedido que ya no es liquidable: se cierra para no reintentar.
        const void_ = decision.reason === 'nothing_to_pay' || current.status === 'reembolsado';
        await repos.settlements.save({
          ...settlement,
          status: void_ ? 'anulada' : settlement.status,
          nextAttemptAt: addMs(now, 60 * MS.minute),
          completedAt: void_ ? now : settlement.completedAt,
          updatedAt: now,
        });
        return { kind: 'done', outcome: { kind: 'noop' } };
      }
      if (decision.action === 'wait') {
        await repos.settlements.save({
          ...settlement,
          blockReason: decision.block,
          nextAttemptAt: decision.retryAt,
          updatedAt: now,
        });
        return { kind: 'done', outcome: { kind: 'waiting', reason: decision.block } };
      }
      // Hay que transferir: se fija el importe y se cuenta el intento (BR5-RS1).
      await repos.settlements.save({
        ...settlement,
        amountCents: decision.amountCents,
        blockReason: undefined,
        attempts: settlement.attempts + 1,
        nextAttemptAt: addMs(now, LEASE_MS),
        updatedAt: now,
      });
      return {
        kind: 'transfer',
        accountId: account?.providerAccountId ?? '',
        chargeId: chargeId ?? '',
        amountCents: decision.amountCents,
      };
    });
    if (plan.kind === 'done') {
      if (plan.outcome.kind === 'waiting') {
        await deps.audit.record({
          actorType: 'system',
          action: 'settlement_blocked',
          resourceType: 'order',
          resourceId: orderId,
          outcome: 'failure',
          correlationId,
          details: { reason: plan.outcome.reason },
        });
      }
      return plan.outcome;
    }

    // 3) Llamada al proveedor, fuera de la transaccion y con clave de idempotencia (BR5-ST3, BR5-RS2).
    const existing = await deps.provider.findTransfer(orderId);
    let transferRef: string | undefined;
    if (existing.ok && existing.value) transferRef = existing.value.transferRef;
    else {
      const sent = await deps.provider.transfer({
        orderId,
        destinationAccountId: plan.accountId,
        amountCents: plan.amountCents,
        chargeId: plan.chargeId,
        idempotencyKey: settlementKey(orderId),
      });
      if (!sent.ok) return this.failedAttempt(orderId, correlationId, sent.error.code);
      transferRef = sent.value.transferRef;
    }

    // 4) Resultado: libro, saldo, liquidacion, pedido y aviso, todo en una transaccion.
    const ref = transferRef;
    const result = await deps.runner.run(systemScope, async (repos) => {
      const now = deps.clock.now();
      const order = await repos.orders.findByIdForUpdate(orderId);
      const settlement = await repos.settlements.findByOrderForUpdate(orderId);
      if (!order || !settlement) return false;
      if (settlement.status === 'transferida') return true;
      const entries = planSettlementEntries({
        orderId,
        artistId: order.artistId,
        amountCents: plan.amountCents,
        ref,
        reasonCode: settlement.releasedBy === 'manual' ? 'liberacion_manual' : 'entrega_confirmada',
      });
      if (!entries.ok) throw new MoneyInvariantError(entries.error);
      await postEntries(repos, entries.value, now);
      await repos.settlements.save({
        ...settlement,
        status: 'transferida',
        transferRef: ref,
        blockReason: undefined,
        completedAt: now,
        updatedAt: now,
      });
      await applyOrderTrigger(
        repos,
        order,
        { type: 'settled' },
        {
          actor: 'sistema',
          now,
          externalRef: ref,
        },
      );
      await repos.notifications.insertMany([
        {
          id: deps.ids.uuid(),
          orderId,
          artistId: order.artistId,
          type: 'liquidacion_artista',
          recipientRole: recipientOf('liquidacion_artista'),
          status: 'pendiente',
          attempts: 0,
          nextAttemptAt: now,
          lastError: undefined,
          createdAt: now,
          sentAt: undefined,
        },
      ]);
      return true;
    });
    if (!result) return { kind: 'noop' };
    await deps.audit.record({
      actorType: 'system',
      action: 'settlement_done',
      resourceType: 'order',
      resourceId: orderId,
      outcome: 'success',
      correlationId,
      details: { amountCents: plan.amountCents },
    });
    return { kind: 'transferred', amountCents: plan.amountCents };
  }

  private async failedAttempt(
    orderId: string,
    correlationId: string,
    code: string,
  ): Promise<SettleOutcome> {
    const { deps } = this;
    const final = await deps.runner.run(systemScope, async (repos) => {
      const now = deps.clock.now();
      const s = await repos.settlements.findByOrderForUpdate(orderId);
      if (!s || s.status !== 'pendiente') return false;
      const exhausted = s.attempts >= MAX_ATTEMPTS;
      const wait = BACKOFF_MS[Math.min(s.attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[0] ?? 0;
      await repos.settlements.save({
        ...s,
        status: exhausted ? 'fallida' : 'pendiente',
        nextAttemptAt: addMs(now, wait),
        updatedAt: now,
      });
      return exhausted;
    });
    deps.logger.warn('settlement_transfer_failed', { correlationId, code });
    if (final) {
      await deps.alerts.raise('liquidacion_fallida', { orderId }, correlationId);
      return { kind: 'failed' };
    }
    return { kind: 'retry' };
  }
}

// ---------------------------------------------------------------------------------------------
// Bandeja de salida de liquidaciones (cada minuto)
// ---------------------------------------------------------------------------------------------
export class RetrySettlements {
  constructor(
    private readonly deps: SettleDeps & { readonly settle: Pick<SettleOrder, 'execute'> },
  ) {}

  async execute(
    correlationId: string,
  ): Promise<{ examined: number; transferred: number; waiting: number; failed: number }> {
    const { deps } = this;
    const now = deps.clock.now();
    const due = await deps.runner.run(systemScope, (r) =>
      r.settlements.claimDue(now, BATCH, LEASE_MS),
    );
    let transferred = 0;
    let waiting = 0;
    let failed = 0;
    for (const s of due) {
      const out = await deps.settle.execute(s.orderId, correlationId);
      if (out.kind === 'transferred') transferred += 1;
      else if (out.kind === 'waiting') waiting += 1;
      else if (out.kind === 'failed' || out.kind === 'retry') failed += 1;
    }
    await this.alertLongBlocked(correlationId);
    return { examined: due.length, transferred, waiting, failed };
  }

  /** Una sola vez por liquidacion: el aviso `liquidacion_bloqueada` a los N dias (BR5-ST5). */
  private async alertLongBlocked(correlationId: string): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    const before = addMs(now, -deps.blockedAlertDays * 24 * MS.hour);
    const list = await deps.runner.run(systemScope, (r) =>
      r.settlements.listBlockedUnalerted(before, BATCH),
    );
    for (const s of list) {
      if (!settlementBlockedTooLong(s.createdAt, now, deps.blockedAlertDays)) continue;
      const marked = await deps.runner.run(systemScope, async (r) => {
        const locked = await r.settlements.findByOrderForUpdate(s.orderId);
        if (!locked || locked.status !== 'pendiente' || locked.alertedAt !== undefined) {
          return false;
        }
        await r.settlements.save({ ...locked, alertedAt: now, updatedAt: now });
        return true;
      });
      if (!marked) continue;
      const code =
        s.blockReason === 'sin_cargo' ? 'liquidacion_sin_cargo' : 'liquidacion_bloqueada';
      await deps.alerts.raise(
        code,
        { orderId: s.orderId, detail: s.blockReason ?? 'pendiente' },
        correlationId,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Liberacion manual (US-041, servicio; BR5-EN2)
// ---------------------------------------------------------------------------------------------
export type ReleaseDeps = SettleDeps & {
  readonly settle: Pick<SettleOrder, 'execute'>;
  /** Aplica el hecho «entregado» al envio y al pedido en la transaccion dada. */
  readonly markDelivered: (
    repos: PayoutsRepos,
    order: Order,
    now: Instant,
  ) => Promise<'delivered' | 'unchanged'>;
};

export type ReleaseResult =
  | { readonly ok: true; readonly settlement: SettleOutcome }
  | {
      readonly ok: false;
      readonly error:
        'not_found' | 'not_releasable' | 'refund_in_progress' | 'reason_required' | 'incident_open';
    };

export class ReleaseDelivery {
  constructor(private readonly deps: ReleaseDeps) {}

  async execute(input: {
    readonly orderId: string;
    readonly reason: string;
    readonly operatorId: string;
    readonly correlationId: string;
  }): Promise<ReleaseResult> {
    const { deps } = this;
    const verdict = await deps.runner.run(systemScope, async (repos) => {
      const now = deps.clock.now();
      const order = await repos.orders.findByIdForUpdate(input.orderId);
      if (!order) return 'not_found' as const;
      const refunds = await repos.refunds.listByOrder(order.id);
      const can = canRelease({
        status: order.status,
        refundPending: refunds.some((r) => r.status === 'solicitado'),
        reason: input.reason,
      });
      if (!can.ok) return can.error;
      if (await repos.manualFlags.hasOpen(order.id)) return 'incident_open' as const;
      const moved = await deps.markDelivered(repos, order, now);
      if (moved === 'unchanged') return 'not_releasable' as const;
      await repos.orderEvents.append({
        orderId: order.id,
        artistId: order.artistId,
        at: now,
        actor: 'operador',
        kind: 'liberacion_manual',
        fromStatus: order.status,
        toStatus: 'entregado',
        reasonCode: input.reason.trim().slice(0, 60),
        externalRef: undefined,
      });
      const s = await repos.settlements.findByOrderForUpdate(order.id);
      if (s && s.releasedBy === undefined) {
        await repos.settlements.save({ ...s, releasedBy: 'manual', updatedAt: now });
      }
      return 'ok' as const;
    });
    if (verdict !== 'ok') return { ok: false, error: verdict };
    await deps.audit.record({
      actorType: 'operator',
      actorId: input.operatorId,
      action: 'manual_release',
      resourceType: 'order',
      resourceId: input.orderId,
      outcome: 'success',
      correlationId: input.correlationId,
      details: { reason: input.reason.trim().slice(0, 60) },
    });
    const settlement = await deps.settle.execute(input.orderId, input.correlationId);
    return { ok: true, settlement };
  }
}

export type { Settlement };
