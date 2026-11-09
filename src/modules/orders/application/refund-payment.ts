import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import { applyOrderTrigger } from './apply-trigger';
import type { OperatorAlerts, OrdersRepos, PaymentProvider } from './ports';

export type RefundDeps = {
  readonly runner: TransactionRunner<OrdersRepos>;
  readonly provider: Pick<PaymentProvider, 'refund' | 'getSession'>;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly alerts: OperatorAlerts;
};

/**
 * NFR-U3-10: reembolso total e idempotente del pago de un pedido perdedor. La clave de idempotencia
 * es el id del pedido, asi que reintentar nunca crea un segundo reembolso.
 */
export class RefundPayment {
  constructor(private readonly deps: RefundDeps) {}

  /** `final` = ultimo intento del trabajo: si falla, el pedido queda con reembolso fallido. */
  async execute(
    orderId: string,
    correlationId: string,
    final: boolean,
  ): Promise<Result<'done' | 'nothing_to_do', AppError>> {
    const order = await this.deps.runner.run(systemScope, (repos) =>
      repos.orders.findById(orderId),
    );
    if (!order || order.status !== 'incidencia' || order.refundStatus !== 'pendiente') {
      return ok('nothing_to_do');
    }

    let paymentIntentId = order.paymentIntentId;
    if (paymentIntentId === undefined && order.checkoutSessionId !== undefined) {
      const session = await this.deps.provider.getSession(order.checkoutSessionId);
      if (session.ok) paymentIntentId = session.value.paymentIntentId;
    }
    if (paymentIntentId === undefined) {
      return this.fail(order.id, order.artistId, correlationId, final, appError('internal'));
    }

    await this.deps.audit.record({
      actorType: 'system',
      action: 'refund_requested',
      resourceType: 'order',
      resourceId: order.id,
      outcome: 'success',
      correlationId,
    });
    const refunded = await this.deps.provider.refund({
      paymentIntentId,
      idempotencyKey: `refund:${order.id}`,
    });
    if (!refunded.ok) {
      return this.fail(order.id, order.artistId, correlationId, final, refunded.error);
    }

    const now = this.deps.clock.now();
    await this.deps.runner.run(systemScope, async (repos) => {
      const locked = await repos.orders.findByIdForUpdate(order.id);
      if (!locked) return;
      const applied = await applyOrderTrigger(
        repos,
        locked,
        { type: 'refund_done' },
        {
          actor: 'sistema',
          now,
          externalRef: refunded.value.refundId,
        },
      );
      if (applied.transition.changed) {
        await repos.orders.save({
          ...applied.order,
          version: applied.order.version + 1,
          refundId: refunded.value.refundId,
          refundStatus: 'hecho',
        });
      }
    });
    await this.deps.audit.record({
      actorType: 'system',
      action: 'refund_done',
      resourceType: 'order',
      resourceId: order.id,
      outcome: 'success',
      correlationId,
    });
    return ok('done');
  }

  private async fail(
    orderId: string,
    artistId: string,
    correlationId: string,
    final: boolean,
    error: AppError,
  ): Promise<Result<'done' | 'nothing_to_do', AppError>> {
    if (final) {
      const now = this.deps.clock.now();
      await this.deps.runner.run(systemScope, async (repos) => {
        const locked = await repos.orders.findByIdForUpdate(orderId);
        if (!locked || locked.refundStatus !== 'pendiente') return;
        const next = {
          ...locked,
          refundStatus: 'fallido' as const,
          version: locked.version + 1,
          updatedAt: now,
        };
        if (await repos.orders.save(next)) {
          await repos.orderEvents.append({
            orderId,
            artistId,
            at: now,
            actor: 'sistema',
            kind: 'reembolso_fallido',
            fromStatus: locked.status,
            toStatus: locked.status,
            reasonCode: undefined,
            externalRef: undefined,
          });
        }
      });
      await this.deps.audit.record({
        actorType: 'system',
        action: 'refund_failed',
        resourceType: 'order',
        resourceId: orderId,
        outcome: 'failure',
        correlationId,
      });
      await this.deps.alerts.raise('reembolso_fallido', { orderId }, correlationId);
    }
    return err(error);
  }
}
