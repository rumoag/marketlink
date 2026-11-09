import type { Clock, Instant } from '@/modules/kernel/domain/clock';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { Logger } from '@/modules/platform/application/ports';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import type { Order, Trigger } from '../domain/order';
import { applyOrderTrigger, evaluateSale } from './apply-trigger';
import type {
  OperatorAlerts,
  OrdersRepos,
  PaymentEvent,
  PaymentProvider,
  CheckoutSession,
} from './ports';

export type ProcessOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'unchanged'; readonly status: Order['status'] }
  | {
      readonly kind: 'applied';
      readonly orderId: string;
      readonly status: Order['status'];
      readonly needsRefund: boolean;
    };

export type ProcessPaymentDeps = {
  readonly runner: TransactionRunner<OrdersRepos>;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly alerts: OperatorAlerts;
  readonly logger: Logger;
  readonly provider: Pick<PaymentProvider, 'getSession'>;
  /** U4: reaccion al pago confirmado (avisos y borrador de envio); idempotente. */
  readonly onPaid?: (orderId: string, correlationId: string) => Promise<void>;
  /** U5: en la misma transaccion que deja el pedido `pagado` (retencion en el libro). */
  readonly inTxPaid?: (repos: OrdersRepos, order: Order, now: Instant) => Promise<void>;
};

/** Evento o sesion consultada, reducidos a lo que decide el pedido. */
export type PaymentFact = {
  readonly eventId: string;
  readonly kind: 'paid' | 'expired';
  readonly sessionId: string;
  readonly orderId: string | undefined;
  readonly paymentIntentId: string | undefined;
};

export const factFromEvent = (event: PaymentEvent): PaymentFact | undefined => {
  // U5: los eventos del cobro solo concilian; no mueven el pedido.
  if (event.type === 'charge_refunded' || event.type === 'dispute_created') return undefined;
  if (event.type === 'completed' || event.type === 'async_succeeded') {
    // Un `completed` con pago aun no realizado (metodo asincrono) espera al aviso posterior.
    if (!event.paid) return undefined;
    return {
      eventId: event.id,
      kind: 'paid',
      sessionId: event.sessionId,
      orderId: event.orderId,
      paymentIntentId: event.paymentIntentId,
    };
  }
  return {
    eventId: event.id,
    kind: 'expired',
    sessionId: event.sessionId,
    orderId: event.orderId,
    paymentIntentId: event.paymentIntentId,
  };
};

export const factFromSession = (session: CheckoutSession): PaymentFact | undefined => {
  if (session.status === 'completada' && session.paid) {
    return {
      eventId: `session:${session.id}`,
      kind: 'paid',
      sessionId: session.id,
      orderId: session.orderId,
      paymentIntentId: session.paymentIntentId,
    };
  }
  if (session.status === 'expirada') {
    return {
      eventId: `session:${session.id}`,
      kind: 'expired',
      sessionId: session.id,
      orderId: session.orderId,
      paymentIntentId: session.paymentIntentId,
    };
  }
  return undefined;
};

/**
 * BR3-WH2 a WH7 y BR3-DP1 a DP5: aplica un hecho de pago al pedido. Una sola transaccion con el
 * pedido y el enlace bloqueados; idempotente (repetirlo no cambia nada).
 */
export class ProcessPaymentFact {
  constructor(private readonly deps: ProcessPaymentDeps) {}

  async execute(fact: PaymentFact, correlationId: string): Promise<ProcessOutcome> {
    const now = this.deps.clock.now();
    const done = await this.deps.runner.run(systemScope, async (repos) => {
      const found =
        fact.orderId !== undefined
          ? await repos.orders.findByIdForUpdate(fact.orderId)
          : await repos.orders.findByCheckoutSession(fact.sessionId);
      if (!found) return undefined;
      // La sesion debe ser la del pedido (o aun no estar guardada): defensa ante eventos cruzados.
      if (found.checkoutSessionId !== undefined && found.checkoutSessionId !== fact.sessionId) {
        return undefined;
      }
      const order =
        fact.orderId !== undefined ? found : await repos.orders.findByIdForUpdate(found.id);
      if (!order) return undefined;

      let trigger: Trigger;
      if (fact.kind === 'paid') {
        const canSell =
          order.status === 'pagado' ||
          order.status === 'incidencia' ||
          order.status === 'reembolsado'
            ? false
            : await evaluateSale(repos, order);
        trigger = { type: 'payment_completed', canSell };
      } else {
        trigger = { type: 'session_expired' };
      }
      const applied = await applyOrderTrigger(repos, order, trigger, {
        actor: 'stripe',
        now,
        externalRef: fact.eventId,
        ...(fact.paymentIntentId !== undefined ? { paymentIntentId: fact.paymentIntentId } : {}),
      });
      if (applied.transition.changed && applied.order.status === 'pagado') {
        await this.deps.inTxPaid?.(repos, applied.order, now);
      }
      return applied;
    });

    if (!done) {
      this.deps.logger.warn('payment_event_without_order', { correlationId, kind: fact.kind });
      return { kind: 'ignored' };
    }
    if (!done.transition.changed) {
      if (done.order.status === 'pagado') await this.deps.onPaid?.(done.order.id, correlationId);
      return { kind: 'unchanged', status: done.order.status };
    }

    const needsRefund = done.transition.effects.includes('request_refund');
    const orderId = done.order.id;
    if (done.transition.status === 'pagado') {
      await this.deps.audit.record({
        actorType: 'system',
        action: 'payment_confirmed',
        resourceType: 'order',
        resourceId: orderId,
        outcome: 'success',
        correlationId,
      });
    }
    if (done.order.status === 'pagado') await this.deps.onPaid?.(orderId, correlationId);
    if (needsRefund) {
      await this.deps.audit.record({
        actorType: 'system',
        action: 'duplicate_payment',
        resourceType: 'order',
        resourceId: orderId,
        outcome: 'failure',
        correlationId,
        details: { listingId: done.order.listingId, reason: done.order.refundReason },
      });
      await this.deps.alerts.raise(
        'doble_pago',
        { orderId, listingId: done.order.listingId },
        correlationId,
      );
    }
    return { kind: 'applied', orderId, status: done.order.status, needsRefund };
  }
}
