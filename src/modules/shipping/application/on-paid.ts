import type { Clock } from '@/modules/kernel/domain/clock';
import type { IdGenerator } from '@/modules/platform/application/ports';
import { systemScope } from '@/modules/platform/application/unit-of-work';
import { buildNotifications, type ShippingRunner } from './apply-fact';

export type OnPaidDeps = {
  readonly runner: ShippingRunner;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Encola `create_shipment_draft` para el pedido. */
  readonly enqueueDraft: (orderId: string) => Promise<unknown>;
};

/**
 * Reaccion al pago confirmado (US-026, US-023): avisos a la artista y a la compradora y, en los
 * pedidos de Stripe, el borrador de envio. Idempotente (indice unico por tipo y pedido): se puede
 * llamar varias veces sin duplicar nada.
 */
export class OnOrderPaid {
  constructor(private readonly deps: OnPaidDeps) {}

  async execute(orderId: string): Promise<void> {
    const now = this.deps.clock.now();
    const stripe = await this.deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findById(orderId);
      if (!order || order.status !== 'pagado') return undefined;
      await repos.notifications.insertMany(
        buildNotifications(
          ['pedido_nuevo_artista', 'confirmacion_compradora'],
          order,
          now,
          this.deps.ids,
        ),
      );
      return order.paymentMode === 'stripe';
    });
    if (stripe) await this.deps.enqueueDraft(orderId);
  }
}
