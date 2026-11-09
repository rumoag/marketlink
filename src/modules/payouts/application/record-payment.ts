import type { Instant } from '@/modules/kernel/domain/clock';
import { planPayment } from '@/modules/ledger/domain/ledger';
import type { Order } from '@/modules/orders/domain/order';
import { MoneyInvariantError, postEntries } from './post-entries';
import type { PayoutsRepos } from './ports';

/**
 * US-045: al pasar un pedido pagado con Stripe a `pagado` se registra, en la misma transaccion,
 * el cobro, la retencion, el envio y la comision (BR5-LD2). Repetirlo no duplica (claves unicas).
 * Los cobros manuales (Bizum directo a la artista) no pasan por la plataforma y no se registran.
 */
export const recordPayment = async (
  repos: Pick<PayoutsRepos, 'ledger' | 'balances'>,
  order: Order,
  now: Instant,
): Promise<void> => {
  if (order.paymentMode !== 'stripe') return;
  const plan = planPayment({
    orderId: order.id,
    artistId: order.artistId,
    workCents: order.workPriceCents,
    shippingCents: order.shippingCents,
    commissionCents: order.commissionCents,
    ref: order.paymentIntentId,
  });
  if (!plan.ok) throw new MoneyInvariantError(plan.error);
  await postEntries(repos, plan.value, now);
};
