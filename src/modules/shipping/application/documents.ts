import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { addMs, MS, type Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { OrdersRepos } from '@/modules/orders/application/ports';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import { isShippingChainStatus } from '../domain/shipment';
import type { ShippingRunner } from './apply-fact';
import type { DraftInvoice, InvoiceRenderer, LabelStorage, ShippingRepos } from './ports';

const generic = (): AppError => appError('not_found');

export const LABEL_URL_TTL_SECONDS = 300;

export type DocumentDeps = {
  readonly runner: ShippingRunner;
  readonly storage: Pick<LabelStorage, 'signedUrl'>;
  readonly renderer: InvoiceRenderer;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly platformName: string;
};

/**
 * US-030 (Q3 A): la etiqueta solo se entrega a la artista del pedido, con sesion, mediante una
 * URL firmada de 5 minutos. Pedido ajeno e inexistente dan la misma respuesta (BR4-LB3).
 */
export class GetLabelDownload {
  constructor(private readonly deps: DocumentDeps) {}

  async execute(
    artistId: string,
    orderId: string,
    correlationId: string,
  ): Promise<Result<{ url: string }, AppError>> {
    const found = await this.deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findById(orderId);
      if (!order || order.artistId !== artistId) return undefined;
      return repos.shipments.findByOrder(orderId);
    });
    if (!found || found.labelKey === undefined) return err(generic());
    const signed = await this.deps.storage.signedUrl(found.labelKey, LABEL_URL_TTL_SECONDS);
    if (!signed.ok) return err(signed.error);
    await this.deps.audit.record({
      actorType: 'artist',
      actorId: artistId,
      action: 'label_downloaded',
      resourceType: 'order',
      resourceId: orderId,
      outcome: 'success',
      correlationId,
    });
    return ok({ url: signed.value });
  }
}

/** US-034 (Q6 A): borrador de factura a demanda, sin NIF, con marca de borrador; no se guarda. */
export class RenderDraftInvoice {
  constructor(private readonly deps: DocumentDeps) {}

  async execute(
    artistId: string,
    orderId: string,
    correlationId: string,
  ): Promise<Result<Uint8Array, AppError>> {
    const data = await this.deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findById(orderId);
      if (!order || order.artistId !== artistId) return undefined;
      const loser = order.status === 'incidencia' && order.refundStatus !== 'ninguno';
      if (!isShippingChainStatus(order.status) || loser) return undefined;
      const email = await repos.contacts.findEmail(artistId);
      return email === undefined ? undefined : { order, email };
    });
    if (!data) return err(generic());
    const { order, email } = data;
    const invoice: DraftInvoice = {
      orderRef: order.id.slice(0, 8),
      issuedAt: this.deps.clock.now(),
      artistName: order.snapshot.artisticName,
      artistEmail: email,
      artistAddress: `${order.sender.street} ${order.sender.number}, ${order.sender.postalCode} ${order.sender.city}`,
      platformName: this.deps.platformName,
      title: order.snapshot.title,
      workCents: order.workPriceCents,
      shippingCents: order.shippingCents,
      totalCents: order.totalCents,
    };
    const pdf = await this.deps.renderer.render(invoice);
    await this.deps.audit.record({
      actorType: 'artist',
      actorId: artistId,
      action: 'invoice_generated',
      resourceType: 'order',
      resourceId: orderId,
      outcome: 'success',
      correlationId,
    });
    return ok(pdf);
  }
}

export type PurgeDeps = {
  readonly runner: TransactionRunner<OrdersRepos & ShippingRepos>;
  readonly storage: { remove(keys: readonly string[]): Promise<Result<void, AppError>> };
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly labelDays: number;
  readonly labelUndeliveredDays: number;
  readonly notificationMonths: number;
};

/** NFR-U4-21/22: borra etiquetas vencidas del almacenamiento y notificaciones de mas de 12 meses. */
export class PurgeLabelsAndNotifications {
  constructor(private readonly deps: PurgeDeps) {}

  async execute(correlationId: string): Promise<{ labels: number; notifications: number }> {
    const now = this.deps.clock.now();
    const batch = await this.deps.runner.run(systemScope, (repos) =>
      repos.shipments.listLabelPurgeable(
        addMs(now, -this.deps.labelDays * MS.day),
        addMs(now, -this.deps.labelUndeliveredDays * MS.day),
        200,
      ),
    );
    let labels = 0;
    for (const s of batch) {
      if (s.labelKey === undefined) continue;
      const removed = await this.deps.storage.remove([s.labelKey]);
      if (!removed.ok) continue; // se reintenta en la pasada siguiente
      await this.deps.runner.run(systemScope, async (repos) => {
        const locked = await repos.shipments.findByOrderForUpdate(s.orderId);
        if (locked) await repos.shipments.save({ ...locked, labelKey: undefined, updatedAt: now });
      });
      labels += 1;
    }
    const notifications = await this.deps.runner.run(systemScope, (repos) =>
      repos.notifications.deleteOlderThan(addMs(now, -this.deps.notificationMonths * 30 * MS.day)),
    );
    if (labels > 0 || notifications > 0) {
      await this.deps.audit.record({
        actorType: 'system',
        action: 'labels_purged',
        resourceType: 'shipment',
        outcome: 'success',
        correlationId,
        details: { labels, notifications },
      });
    }
    return { labels, notifications };
  }
}
