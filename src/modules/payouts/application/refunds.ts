import type { Clock } from '@/modules/kernel/domain/clock';
import { planRefundEntries } from '@/modules/ledger/domain/ledger';
import { applyOrderTrigger } from '@/modules/orders/application/apply-trigger';
import type { OperatorAlerts } from '@/modules/orders/application/ports';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { IdGenerator, Logger } from '@/modules/platform/application/ports';
import { systemScope } from '@/modules/platform/application/unit-of-work';
import type { Refund } from '../domain/entities';
import { planRefund, refundKey, type RefundError, type RefundReason } from '../domain/payouts';
import { MoneyInvariantError, postEntries } from './post-entries';
import type { MoneyProvider } from './ports';
import type { MoneyRunner } from './settlement';

export type RefundDeps = {
  readonly runner: MoneyRunner;
  readonly provider: Pick<MoneyProvider, 'refund'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly audit: AuditLog;
  readonly alerts: OperatorAlerts;
  readonly logger: Logger;
};

export type RefundOrderError =
  | RefundError
  | 'not_found'
  | 'manual_payment'
  | 'no_payment'
  | 'refund_in_progress'
  | 'settlement_in_progress'
  | 'provider_failed';

export type RefundResult =
  | {
      readonly ok: true;
      readonly refundId: string;
      readonly amountCents: number;
      readonly total: boolean;
    }
  | { readonly ok: false; readonly error: RefundOrderError };

/**
 * US-042 (servicio): reembolso total o parcial, solo del operador y solo antes de liquidar
 * (BR5-RF1 a RF4). Fase 1 (transaccion): comprueba y registra la solicitud. Fase 2: llama al
 * proveedor con clave `reembolso:<pedido>:<n>`. Fase 3 (transaccion): libro, saldo y pedido.
 */
export class RefundOrder {
  constructor(private readonly deps: RefundDeps) {}

  async execute(input: {
    readonly orderId: string;
    readonly amountCents: number;
    readonly reason: RefundReason;
    readonly operatorId: string;
    readonly correlationId: string;
  }): Promise<RefundResult> {
    const { deps } = this;
    const opened = await deps.runner.run(systemScope, async (repos) => {
      const now = deps.clock.now();
      const order = await repos.orders.findByIdForUpdate(input.orderId);
      if (!order) return { error: 'not_found' } as const;
      if (order.paymentMode !== 'stripe') return { error: 'manual_payment' } as const;
      if (order.paymentIntentId === undefined) return { error: 'no_payment' } as const;
      const [refunds, ledger, settlement] = await Promise.all([
        repos.refunds.listByOrder(order.id),
        repos.ledger.listByOrder(order.id),
        repos.settlements.findByOrder(order.id),
      ]);
      // Sin retencion registrada no hay dinero de la artista que repartir (p. ej. doble pago de U3).
      if (!ledger.some((e) => e.kind === 'retencion')) return { error: 'not_refundable' } as const;
      if (refunds.some((r) => r.status === 'solicitado')) {
        return { error: 'refund_in_progress' } as const;
      }
      if (
        settlement &&
        settlement.status === 'pendiente' &&
        settlement.blockReason === undefined &&
        settlement.attempts > 0
      ) {
        return { error: 'settlement_in_progress' } as const;
      }
      const done = refunds.filter((r) => r.status === 'hecho');
      const plan = planRefund({
        orderStatus: order.status,
        totalCents: order.totalCents,
        shippingCents: order.shippingCents,
        refundedCents: done.reduce((s, r) => s + r.amountCents, 0),
        refundedShippingCents: done.reduce((s, r) => s + r.shippingPartCents, 0),
        requestCents: input.amountCents,
      });
      if (!plan.ok) return { error: plan.error } as const;
      const refund: Refund = {
        id: deps.ids.uuid(),
        orderId: order.id,
        seq: refunds.reduce((m, r) => Math.max(m, r.seq), 0) + 1,
        amountCents: input.amountCents,
        shippingPartCents: plan.value.shippingPartCents,
        artistPartCents: plan.value.artistPartCents,
        status: 'solicitado',
        refundRef: undefined,
        reasonCode: input.reason,
        requestedBy: 'operador',
        createdAt: now,
        completedAt: undefined,
      };
      await repos.refunds.insert(refund);
      return {
        refund,
        paymentIntentId: order.paymentIntentId,
        isTotal: plan.value.isTotal,
      } as const;
    });
    if ('error' in opened) return { ok: false, error: opened.error };
    const { refund, paymentIntentId, isTotal } = opened;
    await deps.audit.record({
      actorType: 'operator',
      actorId: input.operatorId,
      action: 'refund_requested',
      resourceType: 'order',
      resourceId: input.orderId,
      outcome: 'success',
      correlationId: input.correlationId,
      details: { amountCents: refund.amountCents, reason: refund.reasonCode },
    });

    const sent = await deps.provider.refund({
      paymentIntentId,
      amountCents: refund.amountCents,
      idempotencyKey: refundKey(refund.orderId, refund.seq),
    });
    if (!sent.ok) {
      await deps.runner.run(systemScope, async (repos) => {
        const locked = await repos.refunds.findByIdForUpdate(refund.id);
        if (locked?.status === 'solicitado') {
          await repos.refunds.save({ ...locked, status: 'fallido', completedAt: deps.clock.now() });
        }
      });
      await deps.audit.record({
        actorType: 'system',
        action: 'refund_failed',
        resourceType: 'order',
        resourceId: input.orderId,
        outcome: 'failure',
        correlationId: input.correlationId,
      });
      await deps.alerts.raise('reembolso_fallido', { orderId: input.orderId }, input.correlationId);
      return { ok: false, error: 'provider_failed' };
    }

    await this.complete(refund.id, sent.value.refundRef, isTotal, input.correlationId);
    return { ok: true, refundId: refund.id, amountCents: refund.amountCents, total: isTotal };
  }

  /** Fase 3: libro, saldo y pedido en una transaccion. Idempotente (reembolso ya `hecho`). */
  private async complete(
    refundId: string,
    refundRef: string,
    isTotal: boolean,
    correlationId: string,
  ): Promise<void> {
    const { deps } = this;
    const done = await deps.runner.run(systemScope, async (repos) => {
      const now = deps.clock.now();
      const refund = await repos.refunds.findByIdForUpdate(refundId);
      if (!refund || refund.status === 'hecho') return undefined;
      const order = await repos.orders.findByIdForUpdate(refund.orderId);
      if (!order) return undefined;
      const entries = planRefundEntries({
        orderId: order.id,
        artistId: order.artistId,
        seq: refund.seq,
        split: {
          shippingPartCents: refund.shippingPartCents,
          artistPartCents: refund.artistPartCents,
        },
        ref: refundRef,
      });
      if (!entries.ok) throw new MoneyInvariantError(entries.error);
      await postEntries(repos, entries.value, now);
      await repos.refunds.save({ ...refund, status: 'hecho', refundRef, completedAt: now });

      if (isTotal) {
        await applyOrderTrigger(
          repos,
          order,
          { type: 'refund_total' },
          {
            actor: 'operador',
            now,
            externalRef: refundRef,
          },
        );
      } else {
        await repos.orderEvents.append({
          orderId: order.id,
          artistId: order.artistId,
          at: now,
          actor: 'operador',
          kind: 'reembolso_parcial',
          fromStatus: order.status,
          toStatus: order.status,
          reasonCode: refund.reasonCode,
          externalRef: refundRef,
        });
      }
      // La liquidacion pendiente se ajusta al nuevo reparto (o se anula si no queda nada).
      const settlement = await repos.settlements.findByOrderForUpdate(order.id);
      if (settlement && settlement.status === 'pendiente') {
        const remaining = Math.max(0, settlement.amountCents - refund.artistPartCents);
        await repos.settlements.save({
          ...settlement,
          amountCents: remaining,
          updatedAt: now,
        });
      }
      return refund;
    });
    if (!done) return;
    await deps.audit.record({
      actorType: 'system',
      action: 'refund_done',
      resourceType: 'order',
      resourceId: done.orderId,
      outcome: 'success',
      correlationId,
      details: { amountCents: done.amountCents },
    });
  }
}
