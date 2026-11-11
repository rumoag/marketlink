import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Instant } from '@/modules/kernel/domain/clock';
import { err, ok, unwrap, type Result } from '@/modules/kernel/domain/result';
import { CancelCheckout } from '@/modules/checkout/application/cancel-checkout';
import { ShippingOptionsFinder } from '@/modules/checkout/application/shipping-options';
import { InMemoryProviderCache } from './memory-cache';
import { StartCheckout } from '@/modules/checkout/application/start-checkout';
import { DispatchNotifications } from '@/modules/notifications/application/dispatch';
import type {
  EmailMessage,
  EmailSender,
  NotificationContextLoader,
} from '@/modules/notifications/application/ports';
import {
  ProcessPaymentFact,
  factFromEvent,
} from '@/modules/orders/application/process-payment-event';
import { GetTracking } from '@/modules/orders/application/queries';
import type { Order } from '@/modules/orders/domain/order';
import { ProcessShipmentFact, PollShipments } from '@/modules/shipping/application/apply-fact';
import { ChooseDraftPickup, CreateShipmentDraft } from '@/modules/shipping/application/draft';
import {
  GetLabelDownload,
  PurgeLabelsAndNotifications,
  RenderDraftInvoice,
} from '@/modules/shipping/application/documents';
import { OnOrderPaid } from '@/modules/shipping/application/on-paid';
import type {
  DraftInput,
  InvoiceRenderer,
  LabelStorage,
  ShipmentProvider,
} from '@/modules/shipping/application/ports';
import { GetArtistOrder, GetTrackingDetails } from '@/modules/shipping/application/queries';
import { RemindPayLabel, RemindPickup } from '@/modules/shipping/application/reminders';
import type { DropoffPoint, PickupOption, ShipmentFact } from '@/modules/shipping/domain/shipment';
import { NotificationContextLoaderImpl } from '@/services/notification-context';
import { buildHarness } from './harness';
import {
  MemoryPayments,
  MemoryShipping,
  RecordingAlerts,
  SECRETS,
  checkoutInput,
  sellableListing,
} from './u3-harness';

export class MemoryShipmentProvider implements ShipmentProvider {
  readonly drafts = new Map<string, { ref: string; input: DraftInput }>();
  failCreate = false;
  failFind = false;
  failLabel = false;
  failPickup = false;
  /** Lo que devuelve la consulta de respaldo para cada referencia. */
  readonly facts = new Map<string, ShipmentFact[]>();
  createCalls = 0;
  /** Borradores creados de verdad (sin contar intentos fallidos). */
  created = 0;
  dropoffs: DropoffPoint[] = [
    { name: 'Lejos', address: 'Calle B', schedule: '9-14', distanceKm: 5 },
    { name: 'Cerca', address: 'Calle A', schedule: '9-14', distanceKm: 0.5 },
    { name: 'Medio', address: 'Calle C', schedule: '9-14', distanceKm: 2 },
    { name: 'Muy lejos', address: 'Calle D', schedule: '9-14', distanceKm: 9 },
  ];
  pickups: PickupOption[] = [
    { id: '2026-11-10|09:00-13:00', date: '2026-11-10', slot: '09:00-13:00' },
    { id: '2026-11-11|15:00-19:00', date: '2026-11-11', slot: '15:00-19:00' },
  ];

  findByReference(
    reference: string,
  ): Promise<Result<{ providerRef: string } | undefined, AppError>> {
    if (this.failFind) return Promise.resolve(err(appError('dependency_unavailable')));
    const d = this.drafts.get(reference);
    return Promise.resolve(ok(d ? { providerRef: d.ref } : undefined));
  }
  createDraft(input: DraftInput): Promise<Result<{ providerRef: string }, AppError>> {
    this.createCalls += 1;
    if (this.failCreate) return Promise.resolve(err(appError('dependency_unavailable')));
    this.created += 1;
    const ref = `PL${input.reference.slice(-8)}`;
    this.drafts.set(input.reference, { ref, input });
    return Promise.resolve(ok({ providerRef: ref }));
  }
  fetchFacts(ref: string): Promise<Result<readonly ShipmentFact[], AppError>> {
    const f = this.facts.get(ref);
    return Promise.resolve(f ? ok(f) : err(appError('dependency_unavailable')));
  }
  getLabel(): Promise<Result<Uint8Array, AppError>> {
    if (this.failLabel) return Promise.resolve(err(appError('dependency_unavailable')));
    return Promise.resolve(ok(new TextEncoder().encode('%PDF-1.4 etiqueta')));
  }
  getDropoffs(): Promise<Result<readonly DropoffPoint[], AppError>> {
    return Promise.resolve(ok(this.dropoffs));
  }
  getPickupOptions(): Promise<Result<readonly PickupOption[], AppError>> {
    if (this.failPickup) return Promise.resolve(err(appError('dependency_unavailable')));
    return Promise.resolve(ok(this.pickups));
  }
}

export class RecordingEmail implements EmailSender {
  readonly sent: EmailMessage[] = [];
  mode: 'ok' | 'temporary' | 'permanent' = 'ok';
  send(message: EmailMessage): Promise<Result<void, AppError>> {
    if (this.mode === 'temporary') return Promise.resolve(err(appError('dependency_unavailable')));
    if (this.mode === 'permanent') return Promise.resolve(err(appError('validation')));
    this.sent.push(message);
    return Promise.resolve(ok(undefined));
  }
}

export class MemoryLabels implements LabelStorage {
  readonly objects = new Map<string, Uint8Array>();
  failPut = false;
  put(key: string, bytes: Uint8Array): Promise<Result<void, AppError>> {
    if (this.failPut) return Promise.resolve(err(appError('dependency_unavailable')));
    this.objects.set(key, bytes);
    return Promise.resolve(ok(undefined));
  }
  signedUrl(key: string, ttl: number): Promise<Result<string, AppError>> {
    return Promise.resolve(
      this.objects.has(key)
        ? ok(`https://signed.test/${key}?ttl=${ttl}`)
        : err(appError('not_found')),
    );
  }
  remove(keys: readonly string[]): Promise<Result<void, AppError>> {
    for (const k of keys) this.objects.delete(k);
    return Promise.resolve(ok(undefined));
  }
}

export class TextInvoice implements InvoiceRenderer {
  render(invoice: Parameters<InvoiceRenderer['render']>[0]): Promise<Uint8Array> {
    return Promise.resolve(
      new TextEncoder().encode(`BORRADOR ${invoice.orderRef} ${invoice.totalCents}`),
    );
  }
}

/** Arnes de U4: la composicion de produccion con dobles en memoria. */
export const buildU4 = () => {
  const h = buildHarness();
  const db = h.db;
  const shipping = new MemoryShipping();
  const payments = new MemoryPayments();
  const alerts = new RecordingAlerts();
  const provider = new MemoryShipmentProvider();
  const email = new RecordingEmail();
  const labels = new MemoryLabels();
  const jobs: { type: string; payload: Record<string, unknown> }[] = [];
  const audit = h.audit;

  const onPaid = new OnOrderPaid({
    runner: db,
    clock: h.clock,
    ids: h.ids,
    enqueueDraft: (orderId) => {
      jobs.push({ type: 'create_shipment_draft', payload: { orderId } });
      return Promise.resolve();
    },
  });
  const processor = new ProcessPaymentFact({
    runner: db,
    clock: h.clock,
    audit,
    alerts,
    logger: h.logger,
    provider: payments,
    onPaid: (id) => onPaid.execute(id),
  });
  const quote = new ShippingOptionsFinder({
    shipping,
    points: shipping,
    cache: new InMemoryProviderCache(),
    alerts,
    clock: h.clock,
    logger: h.logger,
    cacheTtlMs: 600_000,
  });
  const start = new StartCheckout({
    runner: db,
    finder: quote,
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
    bizumEnabled: false,
    manualEnabled: false,
    manualPolicy: undefined,
  });
  const processFact = new ProcessShipmentFact({
    runner: db,
    provider,
    storage: labels,
    alerts,
    clock: h.clock,
    ids: h.ids,
    logger: h.logger,
  });
  const draft = new CreateShipmentDraft({
    runner: db,
    provider,
    alerts,
    audit,
    clock: h.clock,
    ids: h.ids,
  });
  const loader: NotificationContextLoader = new NotificationContextLoaderImpl({
    runner: db,
    appUrl: 'https://app.test',
    brand: 'MarketLink',
    operatorEmail: 'operador@example.com',
    secrets: SECRETS,
  });
  const failedAlerts: string[] = [];
  const dispatch = new DispatchNotifications({
    runner: db,
    sender: email,
    loader,
    clock: h.clock,
    logger: h.logger,
    onFailed: (n) => {
      failedAlerts.push(n.type);
      return Promise.resolve();
    },
  });
  const documentDeps = {
    runner: db,
    storage: labels,
    renderer: new TextInvoice(),
    audit,
    clock: h.clock,
    platformName: 'MarketLink',
  };
  const queryDeps = {
    runner: db,
    limiter: h.limiter,
    clock: h.clock,
    secrets: SECRETS,
    manualPolicy: undefined,
  };

  return {
    ...h,
    shipping,
    payments,
    alerts,
    provider,
    email,
    labels,
    jobs,
    failedAlerts,
    processor,
    start,
    cancel: new CancelCheckout({
      runner: db,
      provider: payments,
      processor,
      clock: h.clock,
      audit,
    }),
    processFact,
    draft,
    dispatch,
    poll: new PollShipments({ runner: db, provider, processor: processFact, clock: h.clock }),
    remindPickup: new RemindPickup({ runner: db, alerts, clock: h.clock, ids: h.ids }),
    remindPay: new RemindPayLabel({ runner: db, alerts, clock: h.clock, ids: h.ids }),
    purge: new PurgeLabelsAndNotifications({
      runner: db,
      storage: labels,
      audit,
      clock: h.clock,
      labelDays: 30,
      labelUndeliveredDays: 90,
      notificationMonths: 12,
    }),
    chooseDraftPickup: new ChooseDraftPickup({
      runner: db,
      provider,
      clock: h.clock,
      enqueue: (orderId) => {
        jobs.push({ type: 'create_shipment_draft', payload: { orderId } });
        return Promise.resolve();
      },
    }),
    labelDownload: new GetLabelDownload(documentDeps),
    invoice: new RenderDraftInvoice(documentDeps),
    artistOrder: new GetArtistOrder({ runner: db, clock: h.clock }),
    trackingDetails: new GetTrackingDetails({ base: new GetTracking(queryDeps), runner: db }),
  };
};

export type U4 = ReturnType<typeof buildU4>;

let ipCounter = 0;

/** Obra publicada, compra pagada y notificaciones/borrador encolados; devuelve el pedido. */
export const paidOrder = async (
  u: U4,
  options: {
    modality?: 'punto' | 'recogida';
    artist?: { artistId: string; slug: string };
    fields?: Record<string, string>;
  } = {},
): Promise<{ order: Order; artistId: string; slug: string }> => {
  const base =
    options.artist ??
    (await sellableListing(u as never, { modality: options.modality ?? 'punto' }));
  ipCounter += 1;
  const input = checkoutInput(base.slug, {
    ip: `10.9.0.${ipCounter}`,
    expectedTotalCents: options.modality === 'recogida' ? 25_620 : 25_450,
    serviceId: options.modality === 'recogida' ? 'r-1' : 'p-b',
    ...(options.fields ? { fields: options.fields } : {}),
  });
  if (options.modality === 'recogida') {
    u.shipping.services = u.shipping.services.filter((s) => s.modality === 'recogida');
  }
  unwrap(await u.start.execute(input));
  const order = [...u.db.state.orders.values()].at(-1) as Order;
  const session = u.payments.pay(order.checkoutSessionId as string);
  await u.processor.execute(factFromEvent(u.payments.eventFor(session, 'completed'))!, 'c');
  return {
    order: u.db.state.orders.get(order.id) as Order,
    artistId: base.artistId,
    slug: base.slug,
  };
};

export const fact = (
  type: ShipmentFact['type'],
  at: number,
  extra: Partial<ShipmentFact> = {},
): ShipmentFact => ({
  type,
  at: at as Instant,
  ...extra,
});
