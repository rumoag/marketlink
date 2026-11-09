import type { Instant } from '@/modules/kernel/domain/clock';
import {
  applyTrigger,
  type Effect,
  type Order,
  type OrderActor,
  type OrderEvent,
  type OrderEventKind,
  type Transition,
  type Trigger,
} from '../domain/order';
import type { OrdersRepos } from './ports';

/** Otro proceso cambio el pedido a la vez: el trabajo se reintenta con el estado fresco (BR3-CC1). */
export class ConcurrentOrderUpdateError extends Error {
  constructor() {
    super('concurrent_order_update');
    this.name = 'ConcurrentOrderUpdateError';
  }
}

/** La obra deja de poder venderse entre la comprobacion y la venta: no deberia ocurrir con el bloqueo. */
export class SaleNotPossibleError extends Error {
  constructor() {
    super('sale_not_possible');
    this.name = 'SaleNotPossibleError';
  }
}

export type ApplyContext = {
  readonly actor: OrderActor;
  readonly now: Instant;
  readonly externalRef?: string;
  readonly paymentIntentId?: string;
};

export type Applied = { readonly order: Order; readonly transition: Transition };

type Repos = Pick<OrdersRepos, 'orders' | 'orderEvents' | 'sales'>;

const effectEvent: Record<Effect, OrderEventKind> = {
  mark_sold: 'obra_vendida',
  release_reservation: 'reserva_liberada',
  request_refund: 'reembolso_solicitado',
};

/**
 * ¿Puede venderse la obra a este pedido? Se evalua con el enlace bloqueado, dentro de la misma
 * transaccion que luego aplica el cambio, para que la respuesta siga siendo cierta (BR3-DP1/DP2).
 */
export const evaluateSale = (repos: Pick<OrdersRepos, 'sales'>, order: Order): Promise<boolean> =>
  repos.sales.canSell(order.listingId, order.reservationId);

/**
 * Aplica un disparador a un pedido ya bloqueado: transicion pura, efectos sobre el enlace, pedido
 * con version nueva y eventos, todo en la transaccion del llamador. Idempotente (changed = false).
 */
export const applyOrderTrigger = async (
  repos: Repos,
  order: Order,
  trigger: Trigger,
  ctx: ApplyContext,
): Promise<Applied> => {
  const transition = applyTrigger(order.status, trigger);
  if (!transition.changed) return { order, transition };

  for (const effect of transition.effects) {
    if (effect === 'mark_sold') {
      const sold = await repos.sales.sell(order.listingId, order.id, order.reservationId);
      if (!sold.ok) throw new SaleNotPossibleError();
    } else if (effect === 'release_reservation' && order.reservationId !== undefined) {
      await repos.sales.release(order.reservationId);
    }
  }

  const refunding = transition.effects.includes('request_refund');
  const next: Order = {
    ...order,
    status: transition.status,
    version: order.version + 1,
    updatedAt: ctx.now,
    paymentIntentId: ctx.paymentIntentId ?? order.paymentIntentId,
    refundStatus: refunding
      ? 'pendiente'
      : transition.status === 'reembolsado'
        ? 'hecho'
        : order.refundStatus,
    refundReason: refunding ? transition.reasonCode : order.refundReason,
  };
  if (!(await repos.orders.save(next))) throw new ConcurrentOrderUpdateError();

  const base = {
    orderId: order.id,
    artistId: order.artistId,
    at: ctx.now,
    actor: ctx.actor,
    fromStatus: order.status,
    toStatus: next.status,
    externalRef: ctx.externalRef,
  } as const;
  if (transition.kind !== undefined) {
    const main: OrderEvent = { ...base, kind: transition.kind, reasonCode: transition.reasonCode };
    await repos.orderEvents.append(main);
  }
  for (const effect of transition.effects) {
    const kind = effectEvent[effect];
    if (kind === transition.kind) continue;
    await repos.orderEvents.append({ ...base, kind, reasonCode: undefined });
  }
  return { order: next, transition };
};
