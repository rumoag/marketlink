import { randomBytes } from 'node:crypto';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Instant } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type {
  DeliveryPointProvider,
  ShippingProvider,
  ShippingQuoteRequest,
} from '@/modules/checkout/application/ports';
import { CancelCheckout } from '@/modules/checkout/application/cancel-checkout';
import { ListDeliveryPoints, QuoteOptions } from '@/modules/checkout/application/quote-shipping';
import { ShippingOptionsFinder } from '@/modules/checkout/application/shipping-options';
import { InMemoryProviderCache } from './memory-cache';
import {
  StartCheckout,
  type StartCheckoutInput,
} from '@/modules/checkout/application/start-checkout';
import type { DeliveryPoint, ShippingService } from '@/modules/checkout/domain/quote';
import {
  ExpireStaleOrders,
  PurgeUnpaidOrders,
  ReconcileStripe,
} from '@/modules/orders/application/maintenance';
import type {
  AlertContext,
  CheckoutSession,
  CreateSessionInput,
  OperatorAlertCode,
  OperatorAlerts,
  PaidSession,
  PaymentEvent,
  PaymentProvider,
} from '@/modules/orders/application/ports';
import {
  factFromEvent,
  ProcessPaymentFact,
} from '@/modules/orders/application/process-payment-event';
import {
  ConfirmManualPayment,
  GetSuccessView,
  GetTracking,
  ListArtistOrders,
} from '@/modules/orders/application/queries';
import { RefundPayment } from '@/modules/orders/application/refund-payment';
import { unwrap } from '@/modules/kernel/domain/result';
import { buildHarness } from './harness';

export class MemoryShipping implements ShippingProvider, DeliveryPointProvider {
  calls = 0;
  pointCalls = 0;
  fail = false;
  pointsFail = false;
  services: ShippingService[] = [
    {
      id: 'p-b',
      name: 'Punto B',
      carrier: 'Correos',
      modality: 'punto',
      destination: 'domicilio',
      priceCents: 450,
      transitDays: 3,
    },
    {
      id: 'p-a',
      name: 'Punto A',
      carrier: 'Seur',
      modality: 'punto',
      destination: 'domicilio',
      priceCents: 490,
      transitDays: 2,
    },
    {
      id: 'r-1',
      name: 'Recogida',
      carrier: 'DHL',
      modality: 'recogida',
      destination: 'domicilio',
      priceCents: 620,
      transitDays: 1,
    },
  ];
  points: DeliveryPoint[] = [
    {
      id: 'PT1',
      name: 'Estanco 1',
      address: 'Calle Uno 1, 08001, Barcelona',
      schedule: 'L-V 9-20',
    },
    { id: 'PT2', name: 'Kiosco 2', address: 'Calle Dos 2, 08001, Barcelona', schedule: 'L-S 8-21' },
  ];
  getDeliveryPoints(
    _serviceId: string,
    _postalCode: string,
  ): Promise<Result<readonly DeliveryPoint[], AppError>> {
    this.pointCalls += 1;
    return Promise.resolve(
      this.pointsFail ? err(appError('dependency_unavailable')) : ok(this.points),
    );
  }
  quote(_r: ShippingQuoteRequest): Promise<Result<readonly ShippingService[], AppError>> {
    this.calls += 1;
    return Promise.resolve(this.fail ? err(appError('dependency_unavailable')) : ok(this.services));
  }
}

type Sess = CheckoutSession & { amount: number };

export class MemoryPayments implements PaymentProvider {
  readonly sessions = new Map<string, Sess>();
  readonly refunds = new Map<string, string>();
  failCreate = false;
  failRefund = false;
  failGet = false;

  createCheckoutSession(i: CreateSessionInput): Promise<Result<CheckoutSession, AppError>> {
    if (this.failCreate) return Promise.resolve(err(appError('dependency_unavailable')));
    const existing = [...this.sessions.values()].find((s) => s.orderId === i.orderId);
    if (existing) return Promise.resolve(ok(existing));
    const id = `cs_test_${randomBytes(6).toString('hex')}`;
    const s: Sess = {
      id,
      url: `https://pay.test/${id}`,
      status: 'abierta',
      paid: false,
      paymentIntentId: `pi_${id}`,
      orderId: i.orderId,
      amountCents: i.workPriceCents + i.shippingCents,
      amount: i.workPriceCents + i.shippingCents,
    };
    this.sessions.set(id, s);
    return Promise.resolve(ok(s));
  }
  expireSession(id: string): Promise<Result<CheckoutSession, AppError>> {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve(err(appError('not_found')));
    if (s.status === 'abierta') this.sessions.set(id, { ...s, status: 'expirada', url: undefined });
    return Promise.resolve(ok(this.sessions.get(id) as Sess));
  }
  getSession(id: string): Promise<Result<CheckoutSession, AppError>> {
    if (this.failGet) return Promise.resolve(err(appError('dependency_unavailable')));
    const s = this.sessions.get(id);
    return Promise.resolve(s ? ok(s) : err(appError('not_found')));
  }
  listPaidSessions(_since: Instant): Promise<Result<PaidSession[], AppError>> {
    return Promise.resolve(
      ok(
        [...this.sessions.values()]
          .filter((s) => s.paid)
          .map((s) => ({
            sessionId: s.id,
            orderId: s.orderId,
            paymentIntentId: s.paymentIntentId,
            amountCents: s.amount,
          })),
      ),
    );
  }
  refund(i: { paymentIntentId: string }): Promise<Result<{ refundId: string }, AppError>> {
    if (this.failRefund) return Promise.resolve(err(appError('dependency_unavailable')));
    const id = this.refunds.get(i.paymentIntentId) ?? `re_${this.refunds.size + 1}`;
    this.refunds.set(i.paymentIntentId, id);
    return Promise.resolve(ok({ refundId: id }));
  }
  parseEvent(): Result<PaymentEvent | null, 'invalid_signature'> {
    return err('invalid_signature');
  }
  /** La compradora paga en la pagina de Stripe. */
  pay(id: string): Sess {
    const s = this.sessions.get(id) as Sess;
    const next: Sess = { ...s, status: 'completada', paid: true, url: undefined };
    this.sessions.set(id, next);
    return next;
  }
  eventFor(s: Sess, type: PaymentEvent['type'] = 'completed'): PaymentEvent {
    return {
      id: `evt_${randomBytes(4).toString('hex')}`,
      type,
      sessionId: s.id,
      orderId: s.orderId,
      paymentIntentId: s.paymentIntentId,
      paid: type === 'completed' || type === 'async_succeeded',
      amountCents: s.amount,
    };
  }
}

export class RecordingAlerts implements OperatorAlerts {
  readonly raised: { code: OperatorAlertCode; context: AlertContext }[] = [];
  raise(code: OperatorAlertCode, context: AlertContext): Promise<void> {
    this.raised.push({ code, context });
    return Promise.resolve();
  }
}

export const SECRETS = { current: 'k'.repeat(32), previous: undefined };

/** Arnes de U3: la composicion de produccion con dobles en memoria. */
export const buildU3 = (options: { manual?: boolean; bizum?: boolean } = {}) => {
  const h = buildHarness();
  const db = h.db;
  const shipping = new MemoryShipping();
  const payments = new MemoryPayments();
  const alerts = new RecordingAlerts();
  const manualPolicy = options.manual
    ? { amountDueCents: (o: { totalCents: number }) => o.totalCents }
    : undefined;
  const cache = new InMemoryProviderCache();
  const finder = new ShippingOptionsFinder({
    shipping,
    points: shipping,
    cache,
    alerts,
    clock: h.clock,
    logger: h.logger,
    cacheTtlMs: 10 * 60_000,
  });
  const quote = new QuoteOptions({ runner: db, finder, limiter: h.limiter });
  const listPoints = new ListDeliveryPoints({ runner: db, finder, limiter: h.limiter });
  const audit = h.audit;
  const processor = new ProcessPaymentFact({
    runner: db,
    clock: h.clock,
    audit,
    alerts,
    logger: h.logger,
    provider: payments,
  });
  const startCheckout = new StartCheckout({
    runner: db,
    finder,
    provider: payments,
    limiter: h.limiter,
    alerts,
    audit,
    clock: h.clock,
    ids: h.ids,
    logger: h.logger,
    appUrl: 'https://app.test',
    secrets: SECRETS,
    sessionMinutes: 30,
    reservationMinutes: 32,
    manualReservationHours: 24,
    bizumEnabled: options.bizum ?? false,
    manualEnabled: options.manual ?? false,
    manualPolicy,
  });
  const queryDeps = {
    runner: db,
    limiter: h.limiter,
    clock: h.clock,
    secrets: SECRETS,
    manualPolicy,
  };
  return {
    ...h,
    shipping,
    payments,
    alerts,
    quote,
    listPoints,
    finder,
    cache,
    processor,
    startCheckout,
    cancel: new CancelCheckout({
      runner: db,
      provider: payments,
      processor,
      clock: h.clock,
      audit,
    }),
    refund: new RefundPayment({ runner: db, provider: payments, clock: h.clock, audit, alerts }),
    expire: new ExpireStaleOrders({
      runner: db,
      provider: payments,
      processor,
      clock: h.clock,
      logger: h.logger,
    }),
    reconcile: new ReconcileStripe({
      runner: db,
      provider: payments,
      clock: h.clock,
      audit,
      alerts,
      logger: h.logger,
    }),
    purge: new PurgeUnpaidOrders({ runner: db, clock: h.clock, audit, retentionDays: 30 }),
    tracking: new GetTracking(queryDeps),
    success: new GetSuccessView(queryDeps),
    artistOrders: new ListArtistOrders({ runner: db, clock: h.clock }),
    confirmManual: new ConfirmManualPayment({
      ...queryDeps,
      audit,
      manualEnabled: options.manual ?? false,
    }),
  };
};

export type U3 = ReturnType<typeof buildU3>;

export const buyerFields = (over: Record<string, string> = {}): Record<string, string> => ({
  name: 'Lucia Garcia',
  email: 'lucia@example.com',
  phone: '612345678',
  street: 'Calle Sol 4',
  complement: '2B',
  postalCode: '08001',
  city: 'Barcelona',
  province: 'Barcelona',
  ...over,
});

let keyCounter = 0;
export const nextKey = (): string => `key-${String((keyCounter += 1)).padStart(12, '0')}`;

/** Crea una obra activa lista para comprar y devuelve su slug y artista. */
export const sellableListing = async (u: U3, overrides: Record<string, unknown> = {}) => {
  const artistId = await u.readyArtist();
  const created = unwrap(await u.createListing(artistId, overrides));
  return { artistId, listing: created, slug: created.slug as string };
};

export const checkoutInput = (
  slug: string,
  over: Partial<StartCheckoutInput> = {},
): StartCheckoutInput => ({
  slug,
  fields: buyerFields(),
  acceptTerms: true,
  serviceId: 'p-b',
  pointId: undefined,
  expectedTotalCents: 25_450,
  submissionKey: nextKey(),
  method: 'stripe',
  ip: '203.0.113.9',
  correlationId: 'corr',
  ...over,
});

export { factFromEvent };
