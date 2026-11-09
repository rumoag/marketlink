import { addMs, MS, type Clock } from '@/modules/kernel/domain/clock';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { Logger } from '@/modules/platform/application/ports';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import { purgePersonalData } from '../domain/order';
import { applyOrderTrigger } from './apply-trigger';
import { factFromSession, type ProcessPaymentFact } from './process-payment-event';
import type { OperatorAlerts, OrdersRepos, PaymentProvider } from './ports';

const MAX_SWEEP = 50;

export type ExpireStaleDeps = {
  readonly runner: TransactionRunner<OrdersRepos>;
  readonly provider: Pick<PaymentProvider, 'getSession' | 'expireSession'>;
  readonly processor: Pick<ProcessPaymentFact, 'execute'>;
  readonly clock: Clock;
  readonly logger: Logger;
};

/**
 * BR3-WH6: respaldo por reloj. Cierra los pedidos `pendiente_pago` cuyo plazo vencio hace mas de
 * dos minutos. Si Stripe dice que se pago, se procesa como pago; si Stripe no responde, ese pedido
 * se deja para la pasada siguiente (nunca se expira sin saber si se pago).
 */
export class ExpireStaleOrders {
  constructor(private readonly deps: ExpireStaleDeps) {}

  async execute(
    correlationId: string,
  ): Promise<{ examined: number; closed: number; skipped: number }> {
    const now = this.deps.clock.now();
    const overdue = await this.deps.runner.run(systemScope, (repos) =>
      repos.orders.listOverdue(now, MAX_SWEEP),
    );
    let closed = 0;
    let skipped = 0;
    for (const order of overdue) {
      if (order.paymentMode === 'stripe' && order.checkoutSessionId !== undefined) {
        const session = await this.deps.provider.getSession(order.checkoutSessionId);
        if (!session.ok) {
          skipped += 1;
          continue;
        }
        const fact = factFromSession(session.value);
        if (fact?.kind === 'paid') {
          await this.deps.processor.execute(
            { ...fact, orderId: order.id, eventId: `sweep:${order.id}` },
            correlationId,
          );
          closed += 1;
          continue;
        }
        if (session.value.status === 'abierta') {
          const expired = await this.deps.provider.expireSession(order.checkoutSessionId);
          if (!expired.ok) {
            skipped += 1;
            continue;
          }
          const after = factFromSession(expired.value);
          if (after?.kind === 'paid') {
            await this.deps.processor.execute(
              { ...after, orderId: order.id, eventId: `sweep:${order.id}` },
              correlationId,
            );
            closed += 1;
            continue;
          }
        }
      }
      await this.deps.runner.run(systemScope, async (repos) => {
        const locked = await repos.orders.findByIdForUpdate(order.id);
        if (!locked) return;
        await applyOrderTrigger(
          repos,
          locked,
          { type: 'deadline_passed' },
          {
            actor: 'sistema',
            now: this.deps.clock.now(),
          },
        );
      });
      closed += 1;
    }
    if (overdue.length > 0) {
      this.deps.logger.info('stale_orders_swept', {
        correlationId,
        examined: overdue.length,
        closed,
        skipped,
      });
    }
    return { examined: overdue.length, closed, skipped };
  }
}

// ---------------------------------------------------------------------------------------------
export type ReconcileDeps = {
  readonly runner: TransactionRunner<OrdersRepos>;
  readonly provider: Pick<PaymentProvider, 'listPaidSessions'>;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly alerts: OperatorAlerts;
  readonly logger: Logger;
};

/**
 * NFR-U3-09: compara las sesiones pagadas de las ultimas 48 h en Stripe con los pedidos. Informa;
 * no corrige nada solo.
 */
export class ReconcileStripe {
  constructor(private readonly deps: ReconcileDeps) {}

  async execute(correlationId: string): Promise<{ mismatches: number; error: boolean }> {
    const now = this.deps.clock.now();
    const since = addMs(now, -48 * MS.hour);
    const paid = await this.deps.provider.listPaidSessions(since);
    if (!paid.ok) return { mismatches: 0, error: true };
    const orders = await this.deps.runner.run(systemScope, (repos) =>
      repos.orders.listStripeSince(since, 500),
    );
    const bySession = new Map(orders.map((o) => [o.checkoutSessionId, o]));
    const settled = new Set(['pagado', 'incidencia', 'reembolsado']);
    const paidSessionIds = new Set<string>();
    let mismatches = 0;

    for (const p of paid.value) {
      paidSessionIds.add(p.sessionId);
      const order = bySession.get(p.sessionId);
      if (!order || !settled.has(order.status)) {
        mismatches += 1;
        await this.report(order?.id ?? p.orderId, 'pago_sin_pedido_pagado', correlationId);
      } else if (order.totalCents !== p.amountCents) {
        mismatches += 1;
        await this.report(order.id, 'importe_distinto', correlationId);
      }
    }
    for (const order of orders) {
      const looksPaid = order.status === 'pagado';
      if (looksPaid && order.checkoutSessionId !== undefined && order.createdAt >= since) {
        if (!paidSessionIds.has(order.checkoutSessionId)) {
          mismatches += 1;
          await this.report(order.id, 'pedido_pagado_sin_pago', correlationId);
        }
      }
    }
    this.deps.logger.info('reconciliation_done', { correlationId, mismatches });
    return { mismatches, error: false };
  }

  private async report(
    orderId: string | undefined,
    detail: string,
    correlationId: string,
  ): Promise<void> {
    await this.deps.audit.record({
      actorType: 'system',
      action: 'reconciliation_mismatch',
      resourceType: 'order',
      ...(orderId !== undefined ? { resourceId: orderId } : {}),
      outcome: 'failure',
      correlationId,
      details: { detail },
    });
    await this.deps.alerts.raise(
      'conciliacion_desajuste',
      { ...(orderId !== undefined ? { orderId } : {}), detail },
      correlationId,
    );
  }
}

// ---------------------------------------------------------------------------------------------
export type PurgeDeps = {
  readonly runner: TransactionRunner<OrdersRepos>;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly retentionDays: number;
};

/** NFR-U3-26: vacia los datos personales de pedidos cancelados y expirados pasado el plazo. */
export class PurgeUnpaidOrders {
  constructor(private readonly deps: PurgeDeps) {}

  async execute(correlationId: string): Promise<{ purged: number }> {
    const now = this.deps.clock.now();
    const before = addMs(now, -this.deps.retentionDays * MS.day);
    const purged = await this.deps.runner.run(systemScope, async (repos) => {
      const batch = await repos.orders.listPurgeable(before, 200);
      for (const order of batch) {
        const next = purgePersonalData(order, now);
        const saved = await repos.orders.save({ ...next, version: order.version + 1 });
        if (saved) {
          await repos.orderEvents.append({
            orderId: order.id,
            artistId: order.artistId,
            at: now,
            actor: 'sistema',
            kind: 'datos_purgados',
            fromStatus: order.status,
            toStatus: order.status,
            reasonCode: 'retencion',
            externalRef: undefined,
          });
        }
      }
      return batch.length;
    });
    if (purged > 0) {
      await this.deps.audit.record({
        actorType: 'system',
        action: 'personal_data_purged',
        resourceType: 'order',
        outcome: 'success',
        correlationId,
        details: { count: purged },
      });
    }
    return { purged };
  }
}
