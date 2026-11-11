import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { addMs, type Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { OperatorAlerts } from '@/modules/orders/application/ports';
import type { Order } from '@/modules/orders/domain/order';
import type { IdGenerator } from '@/modules/platform/application/ports';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import { systemScope } from '@/modules/platform/application/unit-of-work';
import { newShipment } from '../domain/entity';
import { choosePickup, type PickupOption } from '../domain/shipment';
import { applyShipmentFactTx, buildNotifications, type ShippingRunner } from './apply-fact';
import type { DraftInput, ShipmentProvider } from './ports';

export type DraftOutcome = 'created' | 'waiting_pickup' | 'skipped';

export type DraftDeps = {
  readonly runner: ShippingRunner;
  readonly provider: Pick<ShipmentProvider, 'findByReference' | 'createDraft' | 'getPickupOptions'>;
  readonly alerts: OperatorAlerts;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
};

const FIFTEEN_MIN = 15 * 60_000;

/**
 * US-027: crea el borrador de envio en Packlink, de forma idempotente (BR4-DR*). En `recogida`
 * espera a que la artista elija fecha y franja (Q2 A).
 */
export class CreateShipmentDraft {
  constructor(private readonly deps: DraftDeps) {}

  async execute(
    orderId: string,
    correlationId: string,
    final: boolean,
  ): Promise<Result<DraftOutcome, AppError>> {
    const { deps } = this;
    const now = deps.clock.now();

    // 1. Situacion: pedido de Stripe `pagado` (o con borrador fallido) y envio aun sin crear.
    const ctx = await deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findByIdForUpdate(orderId);
      if (!order || order.paymentMode !== 'stripe') return undefined;
      if (order.status !== 'pagado' && order.status !== 'error_borrador') return undefined;
      let shipment = await repos.shipments.findByOrderForUpdate(orderId);
      if (!shipment) {
        shipment = newShipment({
          id: deps.ids.uuid(),
          orderId,
          artistId: order.artistId,
          serviceId: order.quote.serviceId,
          carrierName: order.quote.serviceName,
          now,
        });
        await repos.shipments.insert(shipment);
      }
      if (shipment.status !== 'creando') return undefined;
      const listing = await repos.sales.findById(order.listingId);
      const senderEmail = await repos.contacts.findEmail(order.artistId);
      return { order, shipment, listing, senderEmail };
    });
    if (!ctx || !ctx.listing) return ok('skipped');
    const { order, shipment, listing, senderEmail } = ctx;
    if (!order.buyer || !order.destination) return ok('skipped'); // datos ya purgados
    // Packlink exige un correo del remitente; sin el no se puede crear el borrador.
    if (senderEmail === undefined) {
      return this.failDraft(order, correlationId, final, appError('validation'));
    }

    // 2. Recogida: hay que ofrecer fechas y esperar la eleccion.
    if (order.effectiveModality === 'recogida' && shipment.pickup === undefined) {
      if (shipment.pickupRequestedAt === undefined) {
        const options = await deps.provider.getPickupOptions(
          shipment.serviceId,
          order.sender.postalCode,
        );
        if (!options.ok) return this.failDraft(order, correlationId, final, options.error);
        await deps.runner.run(systemScope, async (repos) => {
          const locked = await repos.shipments.findByOrderForUpdate(orderId);
          if (!locked || locked.pickupRequestedAt !== undefined) return;
          await repos.shipments.save({
            ...locked,
            pickupOptions: options.value,
            pickupRequestedAt: now,
            updatedAt: now,
          });
          await repos.notifications.insertMany(
            buildNotifications(['elegir_recogida_artista'], order, now, deps.ids),
          );
        });
      }
      return ok('waiting_pickup');
    }

    // 3. Idempotencia: si ya existe en Packlink, se reutiliza.
    const existing = await deps.provider.findByReference(orderId);
    if (!existing.ok) return this.failDraft(order, correlationId, final, existing.error);
    let providerRef = existing.value?.providerRef;
    if (providerRef === undefined) {
      const input: DraftInput = {
        reference: orderId,
        serviceId: shipment.serviceId,
        sender: { name: order.snapshot.artisticName, email: senderEmail, ...order.sender },
        recipient: {
          name: order.buyer.name,
          email: order.buyer.email,
          phone: order.buyer.phone,
          ...order.destination,
          pointId: order.destination.point?.id,
        },
        parcel: { size: order.snapshot.size, ...listing.parcel },
        declaredValueCents: order.snapshot.declaredValueCents,
        fragile: order.snapshot.fragile,
        modality: order.effectiveModality,
        pickup: shipment.pickup,
      };
      const created = await deps.provider.createDraft(input);
      if (!created.ok) return this.failDraft(order, correlationId, final, created.error);
      providerRef = created.value.providerRef;
    }

    // 4. Guardado: referencia, estado del pedido y aviso al operador en una transaccion.
    const ref = providerRef;
    await deps.runner.run(systemScope, async (repos) => {
      const lockedOrder = await repos.orders.findByIdForUpdate(orderId);
      const lockedShipment = await repos.shipments.findByOrderForUpdate(orderId);
      if (!lockedOrder || !lockedShipment) return;
      await applyShipmentFactTx(
        repos,
        deps.ids,
        lockedOrder,
        {
          ...lockedShipment,
          providerRef: ref,
          nextPollAt: addMs(now, FIFTEEN_MIN),
        },
        { type: 'draft_created', at: now },
        now,
      );
    });
    await deps.audit.record({
      actorType: 'system',
      action: 'shipment_draft_created',
      resourceType: 'order',
      resourceId: orderId,
      outcome: 'success',
      correlationId,
    });
    return ok('created');
  }

  /** Error reintentable; en el ultimo intento el pedido pasa a `error_borrador` y se avisa. */
  private async failDraft(
    order: Order,
    correlationId: string,
    final: boolean,
    error: AppError,
  ): Promise<Result<DraftOutcome, AppError>> {
    if (final) {
      const now = this.deps.clock.now();
      await this.deps.runner.run(systemScope, async (repos) => {
        const lockedOrder = await repos.orders.findByIdForUpdate(order.id);
        const lockedShipment = await repos.shipments.findByOrderForUpdate(order.id);
        if (!lockedOrder || !lockedShipment) return;
        await applyShipmentFactTx(
          repos,
          this.deps.ids,
          lockedOrder,
          lockedShipment,
          { type: 'draft_failed', at: now },
          now,
        );
      });
      await this.deps.alerts.raise(
        'packlink_borrador_fallido',
        { orderId: order.id },
        correlationId,
      );
    }
    return err(error);
  }
}

export type ChoosePickupOutcome =
  | { readonly kind: 'chosen' }
  | { readonly kind: 'unavailable'; readonly options: readonly PickupOption[] };

export type ChoosePickupDeps = {
  readonly runner: ShippingRunner;
  readonly provider: Pick<ShipmentProvider, 'getPickupOptions'>;
  readonly clock: Clock;
  readonly enqueue: (orderId: string) => Promise<unknown>;
};

/** US-032: la artista elige una de las opciones vigentes; se reencola el borrador. */
export class ChooseDraftPickup {
  constructor(private readonly deps: ChoosePickupDeps) {}

  async execute(
    artistId: string,
    orderId: string,
    optionId: string,
  ): Promise<Result<ChoosePickupOutcome, AppError>> {
    const now = this.deps.clock.now();
    const found = await this.deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findByIdForUpdate(orderId);
      if (!order || order.artistId !== artistId) return undefined;
      const shipment = await repos.shipments.findByOrderForUpdate(orderId);
      if (!shipment || shipment.status !== 'creando' || order.effectiveModality !== 'recogida') {
        return undefined;
      }
      if (shipment.pickup !== undefined) return { done: true as const };
      const chosen = choosePickup(shipment.pickupOptions ?? [], optionId);
      if (!chosen.ok) return { done: false as const, order, shipment };
      await repos.shipments.save({ ...shipment, pickup: chosen.value, updatedAt: now });
      await repos.orderEvents.append({
        orderId,
        artistId,
        at: now,
        actor: 'artista',
        kind: 'recogida_elegida',
        fromStatus: order.status,
        toStatus: order.status,
        reasonCode: undefined,
        externalRef: undefined,
      });
      return { done: true as const };
    });
    if (!found) return err(appError('not_found'));
    if (found.done) {
      await this.deps.enqueue(orderId);
      return ok({ kind: 'chosen' });
    }

    // La opcion ya no esta: se vuelven a pedir las fechas y se guardan.
    const fresh = await this.deps.provider.getPickupOptions(
      found.shipment.serviceId,
      found.order.sender.postalCode,
    );
    if (!fresh.ok) return err(fresh.error);
    await this.deps.runner.run(systemScope, async (repos) => {
      const locked = await repos.shipments.findByOrderForUpdate(orderId);
      if (locked)
        await repos.shipments.save({ ...locked, pickupOptions: fresh.value, updatedAt: now });
    });
    return ok({ kind: 'unavailable', options: fresh.value });
  }
}
