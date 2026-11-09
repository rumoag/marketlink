import type { NotificationContextLoader } from '@/modules/notifications/application/ports';
import type { EmailContext } from '@/modules/notifications/domain/notification';
import type { OrdersRepos } from '@/modules/orders/application/ports';
import { tokenForOrder, type TrackingSecrets } from '@/modules/orders/domain/tracking-token';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import type { ShippingRepos } from '@/modules/shipping/application/ports';

export type ContextLoaderDeps = {
  readonly runner: TransactionRunner<OrdersRepos & ShippingRepos>;
  readonly appUrl: string;
  readonly brand: string;
  readonly operatorEmail: string;
  readonly secrets: TrackingSecrets;
};

/**
 * Resuelve el destinatario y el contexto de un email solo en el momento de enviarlo (la tabla
 * `notifications` no guarda direcciones). Si los datos personales ya se purgaron, no hay destinatario.
 */
export class NotificationContextLoaderImpl implements NotificationContextLoader {
  constructor(private readonly deps: ContextLoaderDeps) {}

  async load(orderId: string, role: 'artista' | 'compradora' | 'operador') {
    const { deps } = this;
    return deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findById(orderId);
      if (!order) return undefined;
      const shipment = await repos.shipments.findByOrder(orderId);

      let to: string | undefined;
      if (role === 'artista') to = await repos.contacts.findEmail(order.artistId);
      else if (role === 'compradora') to = order.buyer?.email;
      else to = deps.operatorEmail;
      if (to === undefined) return undefined;

      const token = tokenForOrder(deps.secrets, order);
      const context: EmailContext = {
        brand: deps.brand,
        orderRef: order.id.slice(0, 8),
        title: order.snapshot.title,
        totalCents: order.totalCents,
        shippingCents: order.shippingCents,
        orderUrl: `${deps.appUrl}/artista/pedidos/${order.id}`,
        trackingUrl: token ? `${deps.appUrl}/seguimiento/${token}` : undefined,
        carrier: shipment?.carrierName ?? order.quote.serviceName,
        modality: order.effectiveModality,
        pickupText: shipment?.pickup
          ? `${shipment.pickup.date} (${shipment.pickup.slot})`
          : undefined,
        dropoffs: (shipment?.dropoffPoints ?? []).map((d) => ({
          name: d.name,
          address: d.address,
          schedule: d.schedule,
        })),
        labelCostCents: shipment?.labelCostCents,
      };
      return { to, context };
    });
  }

  /** Avisos sin pedido (retirada): solo la artista, con el importe. Sin datos del pedido. */
  async loadForArtist(artistId: string, amountCents: number | undefined) {
    const { deps } = this;
    return deps.runner.run(systemScope, async (repos) => {
      const to = await repos.contacts.findEmail(artistId);
      if (to === undefined) return undefined;
      const context: EmailContext = {
        brand: deps.brand,
        orderRef: '',
        title: '',
        totalCents: 0,
        shippingCents: 0,
        orderUrl: `${deps.appUrl}/artista/dinero`,
        trackingUrl: undefined,
        carrier: undefined,
        modality: 'punto',
        pickupText: undefined,
        dropoffs: [],
        labelCostCents: undefined,
        amountCents,
      };
      return { to, context };
    });
  }
}
