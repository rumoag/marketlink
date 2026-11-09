import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import {
  artistScope,
  enforceLimit,
  systemScope,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import type { Order } from '../domain/order';
import {
  hashTrackingToken,
  isWellFormedToken,
  toTrackingView,
  tokenForOrder,
  type TrackingSecrets,
  type TrackingView,
} from '../domain/tracking-token';
import { applyOrderTrigger, evaluateSale } from './apply-trigger';
import type { OrdersRepos } from './ports';

const generic = (): AppError => appError('not_found');

/** Politica del importe a pagar por Bizum en modo manual (BR3-MN5: aplazada). */
export interface ManualPaymentPolicy {
  amountDueCents(order: Pick<Order, 'workPriceCents' | 'shippingCents' | 'totalCents'>): number;
}

export type ManualInstructions = { readonly bizumPhone: string; readonly amountCents: number };
export type TrackingResult = TrackingView & { readonly manual: ManualInstructions | undefined };

export type QueryDeps = {
  readonly runner: TransactionRunner<OrdersRepos>;
  readonly limiter: Pick<RateLimiter, 'check'>;
  readonly clock: Clock;
  readonly secrets: TrackingSecrets;
  readonly manualPolicy: ManualPaymentPolicy | undefined;
};

/** Seguimiento por token (BR3-SG1 a SG5): cualquier fallo es la misma respuesta generica. */
export class GetTracking {
  constructor(private readonly deps: QueryDeps) {}

  async execute(
    rawToken: string,
    ip: string,
    correlationId: string,
  ): Promise<Result<TrackingResult, AppError>> {
    const limited = await enforceLimit(this.deps.limiter, 'tracking_ip', ip, {
      failClosed: true,
      correlationId,
    });
    if (!limited.ok) return limited;
    if (!isWellFormedToken(rawToken)) return err(generic());

    const hash = hashTrackingToken(rawToken);
    const found = await this.deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findByTrackingHash(hash);
      if (!order) return undefined;
      const phone =
        order.paymentMode === 'manual' && order.status === 'pendiente_pago'
          ? await repos.contacts.findBizumPhone(order.artistId)
          : undefined;
      return { order, phone };
    });
    if (!found) return err(generic());

    const { order, phone } = found;
    const policy = this.deps.manualPolicy;
    const manual: ManualInstructions | undefined =
      phone !== undefined && policy !== undefined
        ? { bizumPhone: phone, amountCents: policy.amountDueCents(order) }
        : undefined;
    return ok({ ...toTrackingView(order), manual });
  }
}

export type SuccessView = {
  readonly status: Order['status'];
  readonly statusText: string;
  readonly title: string;
  readonly trackingToken: string | undefined;
};

/** Pagina de exito (BR3-EX*): se localiza por el identificador de la sesion de pago. */
export class GetSuccessView {
  constructor(private readonly deps: QueryDeps) {}

  async execute(
    sessionId: string,
    ip: string,
    correlationId: string,
  ): Promise<Result<SuccessView, AppError>> {
    const limited = await enforceLimit(this.deps.limiter, 'tracking_ip', ip, {
      failClosed: true,
      correlationId,
    });
    if (!limited.ok) return limited;
    if (!/^cs_[A-Za-z0-9_]{8,200}$/.test(sessionId)) return err(generic());

    const order = await this.deps.runner.run(systemScope, (repos) =>
      repos.orders.findByCheckoutSession(sessionId),
    );
    if (!order) return err(generic());
    const view = toTrackingView(order);
    return ok({
      status: order.status,
      statusText: view.statusText,
      title: order.snapshot.title,
      trackingToken: tokenForOrder(this.deps.secrets, order),
    });
  }
}

export type ArtistOrderRow = {
  readonly id: string;
  readonly title: string;
  readonly status: Order['status'];
  readonly totalCents: number;
  readonly workPriceCents: number;
  readonly shippingCents: number;
  readonly city: string | undefined;
  readonly createdAtMs: number;
  readonly paymentMode: Order['paymentMode'];
  /** Cobro manual pendiente de que la artista lo confirme. */
  readonly awaitingConfirmation: boolean;
};

/** Pedidos de la artista (BR3-AZ1, AZ2): solo localidad de destino, sin datos personales completos. */
export class ListArtistOrders {
  constructor(private readonly deps: Pick<QueryDeps, 'runner' | 'clock'>) {}

  async execute(artistId: string): Promise<ArtistOrderRow[]> {
    const orders = await this.deps.runner.run(artistScope(artistId), (repos) =>
      repos.orders.listByArtist(artistId, 100),
    );
    const now = this.deps.clock.now();
    return orders
      .filter((o) => o.artistId === artistId)
      .map((o) => ({
        id: o.id,
        title: o.snapshot.title,
        status: o.status,
        totalCents: o.totalCents,
        workPriceCents: o.workPriceCents,
        shippingCents: o.shippingCents,
        city: o.destination?.city,
        createdAtMs: o.createdAt,
        paymentMode: o.paymentMode,
        awaitingConfirmation:
          o.paymentMode === 'manual' && o.status === 'pendiente_pago' && o.expiresAt > now,
      }));
  }
}

export type ConfirmDeps = QueryDeps & {
  readonly audit: AuditLog;
  readonly manualEnabled: boolean;
  /** U4: avisos tras confirmar el cobro manual. */
  readonly onPaid?: (orderId: string, correlationId: string) => Promise<void>;
};

/** US-024: la artista confirma que ha recibido el Bizum (BR3-MN1, MN4, MN6). */
export class ConfirmManualPayment {
  constructor(private readonly deps: ConfirmDeps) {}

  async execute(
    artistId: string,
    orderId: string,
    correlationId: string,
  ): Promise<Result<void, AppError>> {
    // BR3-MN1: con el flag apagado, la accion no existe.
    if (!this.deps.manualEnabled || this.deps.manualPolicy === undefined) return err(generic());
    const now = this.deps.clock.now();

    const result = await this.deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findByIdForUpdate(orderId);
      // BR3-AZ1: otra artista, o un pedido que no es manual, es «no encontrado».
      if (!order || order.artistId !== artistId || order.paymentMode !== 'manual') {
        return err(generic());
      }
      if (order.status === 'pagado') return ok(undefined); // idempotente
      if (order.status !== 'pendiente_pago' || order.expiresAt <= now) {
        return err(appError('conflict')); // BR3-MN6: caducado o ya cerrado
      }
      const canSell = await evaluateSale(repos, order);
      if (!canSell) return err(appError('conflict'));
      await applyOrderTrigger(
        repos,
        order,
        { type: 'manual_confirmed', canSell },
        {
          actor: 'artista',
          now,
        },
      );
      return ok(undefined);
    });
    if (result.ok) {
      await this.deps.onPaid?.(orderId, correlationId);
      await this.deps.audit.record({
        actorType: 'artist',
        actorId: artistId,
        action: 'manual_payment_confirmed',
        resourceType: 'order',
        resourceId: orderId,
        outcome: 'success',
        correlationId,
      });
    }
    return result;
  }
}
