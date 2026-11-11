import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { addMs, MS, type Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import { validate } from '@/modules/kernel/domain/validation';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { IdGenerator, Logger } from '@/modules/platform/application/ports';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import {
  enforceLimit,
  systemScope,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import { applyOrderTrigger } from '@/modules/orders/application/apply-trigger';
import {
  SubmissionKeyTakenError,
  type CheckoutListing,
  type OperatorAlerts,
  type OrdersRepos,
  type PaymentMethod,
  type PaymentProvider,
} from '@/modules/orders/application/ports';
import type { ManualPaymentPolicy } from '@/modules/orders/application/queries';
import {
  computeTotals,
  type Order,
  type OrderStatus,
  type Totals,
} from '@/modules/orders/domain/order';
import {
  deriveTrackingToken,
  issueTrackingToken,
  tokenForOrder,
  type TrackingSecrets,
} from '@/modules/orders/domain/tracking-token';
import { buyerInputSchema } from '../domain/buyer-input';
import {
  RESUME_TTL_MS,
  consentAt,
  hashResumeId,
  isWellFormedSubmissionKey,
  newResumeId,
} from '../domain/consent';
import {
  buildOptions,
  checkSelection,
  toQuoteRef,
  type DeliveryPoint,
  type ShippingService,
} from '../domain/quote';
import { originsOf, unavailableReason } from './quote-shipping';
import type { ShippingOptionsFinder } from './shipping-options';

export type StartCheckoutInput = {
  readonly slug: string;
  /** Campos del formulario tal como llegan (se validan aqui). */
  readonly fields: Readonly<Record<string, string>>;
  readonly acceptTerms: boolean;
  /** U8: servicio elegido (BR8-V1) y, si entrega en un punto, el punto (BR8-V3). */
  readonly serviceId: string;
  readonly pointId: string | undefined;
  /** Total que la compradora vio: solo para detectar cambios, nunca decide el cobro (BR3-TT4). */
  readonly expectedTotalCents: number | undefined;
  readonly submissionKey: string;
  readonly method: 'stripe' | 'manual';
  readonly ip: string;
  readonly correlationId: string;
};

export type StartCheckoutResult =
  | { readonly kind: 'redirect'; readonly url: string; readonly resumeId: string }
  | { readonly kind: 'manual'; readonly trackingToken: string; readonly resumeId: string }
  | { readonly kind: 'existing_open'; readonly url: string }
  | { readonly kind: 'existing_manual'; readonly trackingToken: string | undefined }
  | {
      readonly kind: 'existing_final';
      readonly status: OrderStatus;
      readonly trackingToken: string | undefined;
    }
  | { readonly kind: 'total_changed'; readonly totals: Totals; readonly service: ShippingService }
  | { readonly kind: 'no_shipping' }
  | { readonly kind: 'shipping_down' }
  | { readonly kind: 'servicio_no_disponible' }
  | { readonly kind: 'punto_no_disponible' }
  | { readonly kind: 'obra_no_disponible'; readonly reason: 'pausado' | 'vendido' | 'reservado' }
  | { readonly kind: 'provider_error' };

export type StartCheckoutDeps = {
  readonly runner: TransactionRunner<OrdersRepos>;
  readonly finder: Pick<ShippingOptionsFinder, 'services' | 'points' | 'reportUnavailable'>;
  readonly provider: Pick<PaymentProvider, 'createCheckoutSession' | 'getSession'>;
  readonly limiter: Pick<RateLimiter, 'check'>;
  readonly alerts: OperatorAlerts;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly appUrl: string;
  readonly secrets: TrackingSecrets;
  readonly sessionMinutes: number;
  readonly reservationMinutes: number;
  readonly manualReservationHours: number;
  readonly bizumEnabled: boolean;
  readonly manualEnabled: boolean;
  readonly manualPolicy: ManualPaymentPolicy | undefined;
};

/**
 * Inicia el pago (US-020, US-022). Orden: limites → validar → idempotencia → recotizar → comparar
 * el total → (transaccion) reservar y crear el pedido → Stripe → guardar la sesion. Si Stripe
 * falla, se compensa liberando la reserva (todo o nada, BR3-RS4).
 */
export class StartCheckout {
  constructor(private readonly deps: StartCheckoutDeps) {}

  async execute(input: StartCheckoutInput): Promise<Result<StartCheckoutResult, AppError>> {
    const { deps } = this;
    const opts = { failClosed: true, correlationId: input.correlationId };
    for (const rule of ['checkout_ip', 'reserve_ip'] as const) {
      const limited = await enforceLimit(deps.limiter, rule, input.ip, opts);
      if (!limited.ok) return limited;
    }

    if (input.method === 'manual' && (!deps.manualEnabled || deps.manualPolicy === undefined)) {
      return err(appError('not_found')); // BR3-MN1
    }
    const buyer = validate(buyerInputSchema, input.fields);
    if (!buyer.ok) return buyer;
    if (!input.acceptTerms) {
      return err(
        appError('validation', { details: [{ field: 'acceptTerms', reason: 'requerido' }] }),
      );
    }
    if (!isWellFormedSubmissionKey(input.submissionKey)) {
      return err(
        appError('validation', { details: [{ field: 'submissionKey', reason: 'invalido' }] }),
      );
    }

    // Idempotencia de la peticion (doble clic, recarga o reintento de red).
    const prior = await this.existing(input.submissionKey);
    if (prior) return ok(prior);

    const listing = await deps.runner.run(systemScope, (repos) =>
      repos.sales.findBySlug(input.slug),
    );
    if (!listing) return err(appError('not_found'));
    const blocked = unavailableReason(listing);
    if (blocked) return ok({ kind: 'obra_no_disponible', reason: blocked });

    const perListing = await enforceLimit(deps.limiter, 'reserve_listing', listing.id, opts);
    if (!perListing.ok) {
      await deps.alerts.raise(
        'enlace_bloqueado_abuso',
        { listingId: listing.id },
        input.correlationId,
      );
      return perListing;
    }

    // Revalidar la eleccion justo antes de cobrar (BR8-V1 a V4, D-U8-2): sin estado; el servidor
    // recalcula las opciones (casi siempre desde la cache) y valida servicio, punto y total.
    const selection = await this.resolveSelection(
      listing,
      buyer.value.postalCode,
      input.serviceId,
      input.pointId,
      input.correlationId,
    );
    if (selection.kind === 'servicio_no_disponible' || selection.kind === 'punto_no_disponible') {
      await this.rejected(listing.id, selection.kind, input.correlationId);
      return ok({ kind: selection.kind });
    }
    if (selection.kind === 'no_shipping') return ok({ kind: 'no_shipping' });
    if (selection.kind === 'shipping_down') return ok({ kind: 'shipping_down' });
    if (selection.kind === 'seleccion_invalida') {
      await this.rejected(listing.id, 'seleccion_invalida', input.correlationId);
      return err(appError('validation', { details: [{ field: 'pointId', reason: 'invalido' }] }));
    }
    if (selection.kind !== 'ok') return err(appError('internal'));
    const { service, point } = selection;
    const totals = computeTotals(listing.priceCents, service.priceCents);
    if (!totals.ok) return err(appError('internal'));
    if (input.expectedTotalCents !== totals.value.totalCents) {
      return ok({ kind: 'total_changed', totals: totals.value, service });
    }

    const manual = input.method === 'manual';
    if (manual) {
      const phone = await deps.runner.run(systemScope, (repos) =>
        repos.contacts.findBizumPhone(listing.artistId),
      );
      if (phone === undefined) return err(appError('conflict')); // BR3-MN3
    }

    const now = deps.clock.now();
    const orderId = deps.ids.uuid();
    const issued = issueTrackingToken(deps.secrets, orderId);
    const resumeId = newResumeId();
    const ttlMs = manual
      ? deps.manualReservationHours * MS.hour
      : deps.reservationMinutes * MS.minute;

    const order: Order = {
      id: orderId,
      listingId: listing.id,
      artistId: listing.artistId,
      status: 'pendiente_pago',
      version: 1,
      paymentMode: manual ? 'manual' : 'stripe',
      snapshot: {
        title: listing.title,
        priceCents: listing.priceCents,
        modality: listing.modality,
        size: listing.size,
        declaredValueCents: listing.declaredValueCents,
        fragile: listing.fragile,
        artisticName: listing.artisticName,
        instagram: listing.instagram,
      },
      sender: listing.sender,
      buyer: { name: buyer.value.name, email: buyer.value.email, phone: buyer.value.phone },
      destination: {
        street: buyer.value.street,
        complement: buyer.value.complement,
        postalCode: buyer.value.postalCode,
        city: buyer.value.city,
        province: buyer.value.province,
        point,
      },
      effectiveModality: service.modality,
      alternativeAccepted: false,
      workPriceCents: totals.value.workPriceCents,
      shippingCents: totals.value.shippingCents,
      totalCents: totals.value.totalCents,
      commissionCents: 0,
      quote: toQuoteRef(service),
      consent: consentAt(now),
      checkoutSessionId: undefined,
      paymentIntentId: undefined,
      reservationId: undefined,
      trackingNonce: issued.nonce,
      trackingHash: issued.hash,
      tokenKeyId: issued.keyId,
      resumeHash: hashResumeId(resumeId),
      resumeExpiresAt: addMs(now, RESUME_TTL_MS),
      submissionKey: input.submissionKey,
      expiresAt: addMs(now, ttlMs),
      refundStatus: 'ninguno',
      refundReason: undefined,
      refundId: undefined,
      personalPurgedAt: undefined,
      createdAt: now,
      updatedAt: now,
    };

    // Transaccion A: reservar la obra y crear el pedido (todo o nada).
    let created: Order | { readonly blocked: 'reservado' | 'no_disponible' };
    try {
      created = await deps.runner.run(systemScope, async (repos) => {
        const reserved = await repos.sales.reserve(listing.id, ttlMs);
        if (!reserved.ok) {
          return {
            blocked: reserved.error === 'already_reserved' ? 'reservado' : 'no_disponible',
          } as const;
        }
        const withReservation: Order = { ...order, reservationId: reserved.value.reservationId };
        await repos.orders.insert(withReservation);
        await repos.orderEvents.append({
          orderId,
          artistId: order.artistId,
          at: now,
          actor: 'comprador',
          kind: 'creado',
          fromStatus: 'pendiente_pago',
          toStatus: 'pendiente_pago',
          reasonCode: undefined,
          externalRef: undefined,
        });
        return withReservation;
      });
    } catch (cause) {
      if (cause instanceof SubmissionKeyTakenError) {
        const raced = await this.existing(input.submissionKey);
        if (raced) return ok(raced);
      }
      throw cause;
    }
    if ('blocked' in created) {
      return ok({
        kind: 'obra_no_disponible',
        reason: created.blocked === 'reservado' ? 'reservado' : 'pausado',
      });
    }
    await deps.audit.record({
      actorType: 'buyer',
      action: 'checkout_created',
      resourceType: 'order',
      resourceId: orderId,
      outcome: 'success',
      correlationId: input.correlationId,
      details: { listingId: listing.id, mode: order.paymentMode },
    });

    if (manual) {
      return ok({
        kind: 'manual',
        trackingToken: deriveTrackingToken(deps.secrets.current, orderId, issued.nonce),
        resumeId,
      });
    }

    // Stripe, fuera de la transaccion; la clave de idempotencia es el pedido (NFR-U3-03).
    const methods: PaymentMethod[] = deps.bizumEnabled ? ['card', 'bizum'] : ['card'];
    const session = await deps.provider.createCheckoutSession({
      orderId,
      workTitle: listing.title,
      workPriceCents: created.workPriceCents,
      shippingCents: created.shippingCents,
      customerEmail: buyer.value.email,
      successUrl: `${deps.appUrl}/compra/exito?sesion={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${deps.appUrl}/compra/cancelada`,
      expiresAt: addMs(now, deps.sessionMinutes * MS.minute),
      methods,
      idempotencyKey: `checkout:${orderId}`,
    });
    if (!session.ok || session.value.url === undefined) {
      await this.compensate(orderId, input.correlationId);
      return ok({ kind: 'provider_error' });
    }
    const url = session.value.url;
    const sessionId = session.value.id;
    await deps.runner.run(systemScope, async (repos) => {
      const locked = await repos.orders.findByIdForUpdate(orderId);
      if (!locked || locked.checkoutSessionId !== undefined) return;
      const next: Order = {
        ...locked,
        checkoutSessionId: sessionId,
        version: locked.version + 1,
        updatedAt: deps.clock.now(),
      };
      if (await repos.orders.save(next)) {
        await repos.orderEvents.append({
          orderId,
          artistId: locked.artistId,
          at: deps.clock.now(),
          actor: 'sistema',
          kind: 'pago_iniciado',
          fromStatus: locked.status,
          toStatus: locked.status,
          reasonCode: undefined,
          externalRef: sessionId,
        });
      }
    });
    return ok({ kind: 'redirect', url, resumeId });
  }

  /** BR8-V1 a V4: servicio y punto contra las opciones y la lista de puntos actuales. */
  private async resolveSelection(
    listing: CheckoutListing,
    postalCode: string,
    serviceId: string,
    pointId: string | undefined,
    correlationId: string,
  ): Promise<
    | {
        readonly kind: 'ok';
        readonly service: ShippingService;
        readonly point: DeliveryPoint | undefined;
      }
    | { readonly kind: 'servicio_no_disponible' | 'punto_no_disponible' | 'seleccion_invalida' }
    | { readonly kind: 'no_shipping' | 'shipping_down' }
  > {
    const { finder } = this.deps;
    const services = await finder.services(listing, postalCode, correlationId);
    if (!services.ok) {
      await finder.reportUnavailable(listing, postalCode, true, correlationId);
      return { kind: 'shipping_down' };
    }
    const options = buildOptions(services.value, originsOf(listing));
    if (options.preselected === undefined) {
      await finder.reportUnavailable(listing, postalCode, false, correlationId);
      return { kind: 'no_shipping' };
    }
    // Solo se piden los puntos si el servicio entrega en un punto y la peticion trae uno.
    let points: readonly DeliveryPoint[] | undefined;
    const wanted = [...options.groups.punto].find((s) => s.id === serviceId);
    if (wanted !== undefined && pointId !== undefined && pointId !== '') {
      const res = await finder.points(serviceId, postalCode, correlationId);
      if (!res.ok) return { kind: 'shipping_down' };
      points = res.value;
    }
    return checkSelection(options, serviceId, pointId, points);
  }

  private async rejected(listingId: string, reason: string, correlationId: string): Promise<void> {
    await this.deps.audit.record({
      actorType: 'buyer',
      action: 'delivery_selection_rejected',
      resourceType: 'listing',
      resourceId: listingId,
      outcome: 'denied',
      correlationId,
      details: { reason },
    });
    this.deps.logger.warn('selection_rejected', { correlationId, reason });
  }

  /** Stripe fallo: libera la reserva y cancela el pedido (BR3-RS4). Nunca lanza. */
  private async compensate(orderId: string, correlationId: string): Promise<void> {
    try {
      await this.deps.runner.run(systemScope, async (repos) => {
        const locked = await repos.orders.findByIdForUpdate(orderId);
        if (!locked) return;
        await applyOrderTrigger(
          repos,
          locked,
          { type: 'provider_failed' },
          {
            actor: 'sistema',
            now: this.deps.clock.now(),
          },
        );
      });
    } catch {
      // El respaldo por reloj lo cerrara al vencer el plazo.
      this.deps.logger.error('checkout_compensation_failed', { correlationId, orderId });
    }
  }

  private async existing(submissionKey: string): Promise<StartCheckoutResult | undefined> {
    const order = await this.deps.runner.run(systemScope, (repos) =>
      repos.orders.findBySubmissionKey(submissionKey),
    );
    if (!order) return undefined;
    const token = tokenForOrder(this.deps.secrets, order);
    if (order.status !== 'pendiente_pago') {
      return { kind: 'existing_final', status: order.status, trackingToken: token };
    }
    if (order.paymentMode === 'manual') return { kind: 'existing_manual', trackingToken: token };
    if (order.checkoutSessionId !== undefined) {
      const session = await this.deps.provider.getSession(order.checkoutSessionId);
      if (session.ok && session.value.status === 'abierta' && session.value.url !== undefined) {
        return { kind: 'existing_open', url: session.value.url };
      }
    }
    return { kind: 'existing_final', status: order.status, trackingToken: token };
  }
}
