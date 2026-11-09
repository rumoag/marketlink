import { addMs, MS, type Clock, type Instant } from '@/modules/kernel/domain/clock';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import {
  recipientOf,
  type Notification,
  type NotificationType,
} from '@/modules/notifications/domain/notification';
import { ConcurrentOrderUpdateError } from '@/modules/orders/application/apply-trigger';
import type { OperatorAlerts, OrdersRepos } from '@/modules/orders/application/ports';
import type { Order } from '@/modules/orders/domain/order';
import type { Logger, IdGenerator } from '@/modules/platform/application/ports';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import { stateOf, type Shipment } from '../domain/entity';
import {
  applyFact,
  isShippingChainStatus,
  pollDelayMs,
  selectDropoffs,
  shippingMarginCents,
  type ShipmentFact,
} from '../domain/shipment';
import type { LabelStorage, ShipmentProvider, ShippingRepos } from './ports';

export type ShippingRunner = TransactionRunner<OrdersRepos & ShippingRepos>;

/** Filas de la bandeja de salida para estos tipos (una por tipo y pedido: el indice unico evita repetir). */
export const buildNotifications = (
  types: readonly NotificationType[],
  order: Pick<Order, 'id' | 'artistId'>,
  now: Instant,
  ids: IdGenerator,
): Notification[] =>
  types.map((type) => ({
    id: ids.uuid(),
    orderId: order.id,
    artistId: order.artistId,
    type,
    recipientRole: recipientOf(type),
    status: 'pendiente',
    attempts: 0,
    nextAttemptAt: now,
    lastError: undefined,
    createdAt: now,
    sentAt: undefined,
  }));

export type AppliedFact = {
  readonly changed: boolean;
  readonly order: Order;
  readonly shipment: Shipment;
  readonly incident: boolean;
};

/**
 * Aplica un hecho al envio y al pedido (ya bloqueados) dentro de la transaccion del llamador:
 * estado del envio, estado y eventos del pedido, coste y margen, y la bandeja de salida (BR4-ES1,
 * BR4-NT1). Idempotente y solo hacia delante.
 */
export const applyShipmentFactTx = async (
  repos: OrdersRepos & ShippingRepos,
  ids: IdGenerator,
  order: Order,
  shipment: Shipment,
  fact: ShipmentFact,
  now: Instant,
  /** U5: dentro de la misma transaccion, al dejar el pedido en `entregado` (liquidacion pendiente). */
  onDelivered?: (repos: OrdersRepos & ShippingRepos, order: Order, now: Instant) => Promise<void>,
): Promise<AppliedFact> => {
  const same: AppliedFact = { changed: false, order, shipment, incident: false };
  if (!isShippingChainStatus(order.status)) return same;

  const res = applyFact(stateOf(shipment), fact);
  const trackingUrl = fact.trackingUrl ?? shipment.trackingUrl;
  const trackingCode = fact.trackingCode ?? shipment.trackingCode;
  const labelCostCents = shipment.labelCostCents ?? fact.labelCostCents;
  const infoChanged =
    trackingUrl !== shipment.trackingUrl ||
    trackingCode !== shipment.trackingCode ||
    labelCostCents !== shipment.labelCostCents;
  if (!res.changed && !infoChanged) return same;

  const nextShipment: Shipment = {
    ...shipment,
    trackingUrl,
    trackingCode,
    labelCostCents,
    ...(res.changed
      ? {
          status: res.state.status,
          incident: res.state.incident,
          failureReason: res.state.draftFailed ? 'borrador' : undefined,
          lastProviderEventAt: res.state.lastEventAt,
          deliveredAt:
            res.state.status === 'entregado' ? (shipment.deliveredAt ?? now) : shipment.deliveredAt,
          nextPollAt: res.state.status === 'entregado' ? undefined : shipment.nextPollAt,
          draftCreatedAt:
            fact.type === 'draft_created'
              ? (shipment.draftCreatedAt ?? now)
              : shipment.draftCreatedAt,
        }
      : {}),
    updatedAt: now,
  };
  await repos.shipments.save(nextShipment);

  const costChanged = labelCostCents !== order.labelCostCents;
  const statusChanged = res.changed && res.orderStatus !== order.status;
  let nextOrder = order;
  if (statusChanged || costChanged) {
    nextOrder = {
      ...order,
      status: statusChanged ? res.orderStatus : order.status,
      version: order.version + 1,
      updatedAt: now,
      labelCostCents,
      marginCents:
        labelCostCents !== undefined
          ? shippingMarginCents({
              shippingCents: order.shippingCents,
              labelCostCents,
              totalCents: order.totalCents,
            })
          : order.marginCents,
    };
    if (!(await repos.orders.save(nextOrder))) throw new ConcurrentOrderUpdateError();
  }
  if (nextOrder.status === 'entregado' && order.status !== 'entregado') {
    await onDelivered?.(repos, nextOrder, now);
  }
  if (res.changed && res.eventKind !== undefined) {
    await repos.orderEvents.append({
      orderId: order.id,
      artistId: order.artistId,
      at: now,
      actor: 'sistema',
      kind: res.eventKind,
      fromStatus: order.status,
      toStatus: nextOrder.status,
      reasonCode: res.state.incident,
      externalRef: undefined,
    });
  }
  if (res.changed && res.notifications.length > 0) {
    await repos.notifications.insertMany(buildNotifications(res.notifications, order, now, ids));
  }
  return {
    changed: res.changed,
    order: nextOrder,
    shipment: nextShipment,
    incident: res.changed && res.eventKind === 'incidencia_envio',
  };
};

export type ProcessFactDeps = {
  readonly runner: ShippingRunner;
  readonly provider: Pick<ShipmentProvider, 'getLabel' | 'getDropoffs'>;
  readonly storage: Pick<LabelStorage, 'put'>;
  readonly alerts: OperatorAlerts;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly onDelivered?: (
    repos: OrdersRepos & ShippingRepos,
    order: Order,
    now: Instant,
  ) => Promise<void>;
};

export type FactOutcome = 'applied' | 'unchanged' | 'unknown_reference';

/**
 * Procesa un hecho de transporte venga de donde venga (webhook o consulta, BR4-EV*). Un
 * `label_ready` primero descarga y guarda el PDF: el pedido solo pasa a `etiqueta_lista` cuando
 * el archivo ya esta guardado (BR4-LB1).
 */
export class ProcessShipmentFact {
  constructor(private readonly deps: ProcessFactDeps) {}

  async execute(
    providerRef: string,
    fact: ShipmentFact,
    correlationId: string,
    final = false,
  ): Promise<Result<FactOutcome, AppError>> {
    if (fact.type === 'label_ready') return this.withLabel(providerRef, fact, correlationId, final);
    return ok(await this.apply(providerRef, fact, correlationId, undefined));
  }

  private async apply(
    providerRef: string,
    fact: ShipmentFact,
    correlationId: string,
    patch: Partial<Shipment> | undefined,
  ): Promise<FactOutcome> {
    const now = this.deps.clock.now();
    const done = await this.deps.runner.run(systemScope, async (repos) => {
      const shipment = await repos.shipments.findByProviderRefForUpdate(providerRef);
      if (!shipment) return undefined;
      const order = await repos.orders.findByIdForUpdate(shipment.orderId);
      if (!order) return undefined;
      const base = patch ? { ...shipment, ...patch } : shipment;
      return applyShipmentFactTx(
        repos,
        this.deps.ids,
        order,
        base,
        fact,
        now,
        this.deps.onDelivered,
      );
    });
    if (!done) {
      this.deps.logger.warn('shipment_fact_unknown_reference', { correlationId, type: fact.type });
      return 'unknown_reference';
    }
    if (done.incident) {
      await this.deps.alerts.raise(
        'incidencia_envio',
        { orderId: done.order.id, detail: done.shipment.incident ?? 'desconocida' },
        correlationId,
      );
    }
    return done.changed ? 'applied' : 'unchanged';
  }

  private async withLabel(
    providerRef: string,
    fact: ShipmentFact,
    correlationId: string,
    final: boolean,
  ): Promise<Result<FactOutcome, AppError>> {
    const ctx = await this.deps.runner.run(systemScope, async (repos) => {
      const shipment = await repos.shipments.findByProviderRefForUpdate(providerRef);
      if (!shipment) return undefined;
      const order = await repos.orders.findByIdForUpdate(shipment.orderId);
      return order ? { shipment, order } : undefined;
    });
    if (!ctx) return ok('unknown_reference');
    if (ctx.shipment.labelKey !== undefined) {
      return ok(await this.apply(providerRef, fact, correlationId, undefined));
    }

    const fail = async (error: AppError): Promise<Result<FactOutcome, AppError>> => {
      if (final) {
        await this.deps.alerts.raise(
          'etiqueta_no_descargada',
          { orderId: ctx.order.id },
          correlationId,
        );
      }
      return err(error);
    };

    const pdf = await this.deps.provider.getLabel(providerRef);
    if (!pdf.ok) return fail(pdf.error);
    const key = `labels/${ctx.order.id}/${this.deps.ids.uuid()}.pdf`;
    const stored = await this.deps.storage.put(key, pdf.value);
    if (!stored.ok) return fail(stored.error);

    // Puntos de entrega (no bloquean la etiqueta si fallan, BR4-PT1).
    let dropoffPoints = ctx.shipment.dropoffPoints;
    if (ctx.order.effectiveModality === 'punto') {
      const points = await this.deps.provider.getDropoffs(
        ctx.shipment.serviceId,
        ctx.order.sender.postalCode,
      );
      dropoffPoints = points.ok ? selectDropoffs(points.value) : [];
    }
    return ok(await this.apply(providerRef, fact, correlationId, { labelKey: key, dropoffPoints }));
  }
}

// ---------------------------------------------------------------------------------------------
export type PollDeps = {
  readonly runner: ShippingRunner;
  readonly provider: Pick<ShipmentProvider, 'fetchFacts'>;
  readonly processor: Pick<ProcessShipmentFact, 'execute'>;
  readonly clock: Clock;
};

const POLL_LEASE_MS = 5 * MS.minute;
const POLL_BATCH = 20;

/**
 * Consulta de respaldo (BR4-EV2, Q2 A): toma por lotes los envios abiertos que toca mirar,
 * convierte lo que dice Packlink en los mismos hechos que traeria el webhook y reprograma.
 */
export class PollShipments {
  constructor(private readonly deps: PollDeps) {}

  async execute(correlationId: string): Promise<{ examined: number; failed: number }> {
    const now = this.deps.clock.now();
    const due = await this.deps.runner.run(systemScope, (repos) =>
      repos.shipments.claimDueForPolling(now, POLL_BATCH, POLL_LEASE_MS),
    );
    let failed = 0;
    for (const shipment of due) {
      if (shipment.providerRef === undefined) continue;
      const facts = await this.deps.provider.fetchFacts(shipment.providerRef);
      let nextPollAt: Instant | undefined = addMs(this.deps.clock.now(), 15 * MS.minute);
      if (!facts.ok) failed += 1;
      else {
        const ordered = [...facts.value].sort((a, b) => a.at - b.at);
        for (const fact of ordered) {
          const r = await this.deps.processor.execute(shipment.providerRef, fact, correlationId);
          if (!r.ok) failed += 1;
        }
        const closed = ordered.some((f) => f.type === 'delivered');
        const age = this.deps.clock.now() - shipment.createdAt;
        nextPollAt = closed ? undefined : addMs(this.deps.clock.now(), pollDelayMs(age));
      }
      await this.deps.runner.run(systemScope, async (repos) => {
        const locked = await repos.shipments.findByOrderForUpdate(shipment.orderId);
        if (!locked) return;
        const open = locked.status !== 'entregado';
        await repos.shipments.save({
          ...locked,
          nextPollAt: open ? nextPollAt : undefined,
          updatedAt: this.deps.clock.now(),
        });
      });
    }
    return { examined: due.length, failed };
  }
}

/** Util para el codigo de error de un fallo no clasificado. */
export const internalError = (): AppError => appError('internal');
