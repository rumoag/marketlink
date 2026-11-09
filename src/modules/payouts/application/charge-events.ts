import type { OperatorAlerts, PaymentEvent } from '@/modules/orders/application/ports';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import { systemScope } from '@/modules/platform/application/unit-of-work';
import type { MoneyRunner } from './settlement';

/**
 * Eventos del cobro (`charge.refunded`, `charge.dispute.created`, BR5-RF4, BR5-RF6). Solo
 * conciliacion: avisan al operador y nunca mueven dinero ni cambian el pedido.
 *  - Reembolso hecho fuera del servicio (panel de Stripe): importe mayor que el que conocemos.
 *  - Disputa abierta: aviso inmediato.
 * Un reembolso propio (hecho o solicitado) coincide con lo conocido y no genera aviso.
 */
export class HandleChargeEvent {
  constructor(
    private readonly deps: {
      readonly runner: MoneyRunner;
      readonly audit: AuditLog;
      readonly alerts: OperatorAlerts;
    },
  ) {}

  async execute(
    event: PaymentEvent,
    correlationId: string,
  ): Promise<'ignored' | 'known' | 'alerted'> {
    const { deps } = this;
    if (event.type !== 'charge_refunded' && event.type !== 'dispute_created') return 'ignored';
    if (event.paymentIntentId === undefined) return 'ignored';
    const paymentIntentId = event.paymentIntentId;

    const known = await deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findByPaymentIntent(paymentIntentId);
      if (!order) return undefined;
      const refunds = await repos.refunds.listByOrder(order.id);
      const own = refunds
        .filter((r) => r.status !== 'fallido')
        .reduce((sum, r) => sum + r.amountCents, 0);
      // El reembolso automatico por doble pago (U3) devuelve todo el cobro.
      const automatic = order.refundStatus === 'hecho' || order.refundStatus === 'pendiente';
      return { orderId: order.id, knownRefundedCents: automatic ? order.totalCents : own };
    });
    if (!known) return 'ignored';

    if (event.type === 'dispute_created') {
      await deps.audit.record({
        actorType: 'system',
        action: 'dispute_opened',
        resourceType: 'order',
        resourceId: known.orderId,
        outcome: 'failure',
        correlationId,
      });
      await deps.alerts.raise('disputa_abierta', { orderId: known.orderId }, correlationId);
      return 'alerted';
    }
    const refunded = event.amountCents ?? 0;
    if (refunded <= known.knownRefundedCents) return 'known';
    await deps.audit.record({
      actorType: 'system',
      action: 'charge_refunded_external',
      resourceType: 'order',
      resourceId: known.orderId,
      outcome: 'failure',
      correlationId,
      details: { refundedCents: refunded, knownCents: known.knownRefundedCents },
    });
    await deps.alerts.raise('reembolso_externo', { orderId: known.orderId }, correlationId);
    return 'alerted';
  }
}
