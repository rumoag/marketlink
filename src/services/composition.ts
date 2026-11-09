import { NextResponse, type NextRequest } from 'next/server';
import { SignInService } from '@/modules/accounts/application/sign-in-service';
import { AccountService } from '@/modules/accounts/application/account-service';
import type { AuthPort, PayoutProvider } from '@/modules/accounts/application/ports';
import { SessionResolverImpl } from '@/modules/accounts/infrastructure/session-resolver';
import { StripePayoutAdapter } from '@/modules/accounts/infrastructure/stripe-payout-adapter';
import { SupabaseAuthAdapter } from '@/modules/accounts/infrastructure/supabase-auth-adapter';
import { JobQueue } from '@/modules/jobs/application/job-queue';
import { createRegistry } from '@/modules/jobs/infrastructure/handlers';
import { PgJobStore } from '@/modules/jobs/infrastructure/pg-job-store';
import { appError } from '@/modules/kernel/domain/app-error';
import { systemClock, type Instant } from '@/modules/kernel/domain/clock';
import type { Order } from '@/modules/orders/domain/order';
import { parsePaymentEvent } from './ingest-payment-event';
import { ListingService } from '@/modules/listings/application/listing-service';
import { PhotoService } from '@/modules/listings/application/photo-service';
import type { ImageProcessor, PhotoStorage } from '@/modules/listings/application/ports';
import { ReservationService } from '@/modules/listings/application/reservation-service';
import { CancelCheckout } from '@/modules/checkout/application/cancel-checkout';
import { QuoteShipping } from '@/modules/checkout/application/quote-shipping';
import { StartCheckout } from '@/modules/checkout/application/start-checkout';
import type { ShippingProvider } from '@/modules/checkout/application/ports';
import { PacklinkShippingAdapter } from '@/modules/checkout/infrastructure/packlink-shipping-adapter';
import {
  ExpireStaleOrders,
  PurgeUnpaidOrders,
  ReconcileStripe,
} from '@/modules/orders/application/maintenance';
import type { PaymentProvider } from '@/modules/orders/application/ports';
import { ProcessPaymentFact } from '@/modules/orders/application/process-payment-event';
import {
  ConfirmManualPayment,
  GetSuccessView,
  GetTracking,
  ListArtistOrders,
  type ManualPaymentPolicy,
} from '@/modules/orders/application/queries';
import { RefundPayment } from '@/modules/orders/application/refund-payment';
import { ArtistContactService } from '@/modules/orders/application/contact-service';
import { AuditLogOperatorAlerts } from '@/modules/orders/infrastructure/operator-alerts';
import { StripePaymentAdapter } from '@/modules/orders/infrastructure/stripe-payment-adapter';
import { SharpImageProcessor } from '@/modules/listings/infrastructure/sharp-image-processor';
import { SupabasePhotoStorage } from '@/modules/listings/infrastructure/supabase-photo-storage';
import { toErrorResponse } from '@/modules/platform/application/error-handler';
import { ROUTE_TABLE } from '@/modules/platform/domain/route-table';
import { createResilientFetch } from '@/modules/platform/infrastructure/resilient-fetch';
import { createPipeline } from '@/modules/platform/infrastructure/request-pipeline';
import { PgTransactionRunner } from '@/modules/platform/infrastructure/pg-runner';
import { getRuntime, type Runtime } from '@/modules/platform/infrastructure/runtime';
import { generateNonce, securityHeaders } from '@/modules/platform/infrastructure/security-headers';
import { secureRandom, uuidGenerator } from '@/modules/platform/infrastructure/secure-random';
import {
  FakeAuth,
  FakePayoutProvider,
  FakePaymentProvider,
  FakeShippingProvider,
  FakeShipmentProvider,
  FakeEmailSender,
  FakeFinanceStorage,
  FakeLabelStorage,
  FakeMoneyProvider,
  MemoryPhotoStorage,
} from '@/testing/e2e-doubles';
import { ApplyAccountEventUseCase } from './apply-account-event';
import { IngestAccountEvent } from './ingest-account-event';
import { registerU2Jobs } from './job-handlers';
import { DispatchNotifications } from '@/modules/notifications/application/dispatch';
import type { EmailSender } from '@/modules/notifications/application/ports';
import { ResendEmailSender } from '@/modules/notifications/infrastructure/resend-email-sender';
import { ChooseDraftPickup, CreateShipmentDraft } from '@/modules/shipping/application/draft';
import {
  GetLabelDownload,
  PurgeLabelsAndNotifications,
  RenderDraftInvoice,
} from '@/modules/shipping/application/documents';
import { PollShipments, ProcessShipmentFact } from '@/modules/shipping/application/apply-fact';
import { OnOrderPaid } from '@/modules/shipping/application/on-paid';
import type { LabelStorage, ShipmentProvider } from '@/modules/shipping/application/ports';
import { GetArtistOrder, GetTrackingDetails } from '@/modules/shipping/application/queries';
import { RemindPayLabel, RemindPickup } from '@/modules/shipping/application/reminders';
import { PacklinkShipmentAdapter } from '@/modules/shipping/infrastructure/packlink-shipment-adapter';
import { PdfLibInvoiceRenderer } from '@/modules/shipping/infrastructure/pdf-invoice-renderer';
import { SupabaseLabelStorage } from '@/modules/shipping/infrastructure/supabase-label-storage';
import { HandleChargeEvent } from '@/modules/payouts/application/charge-events';
import {
  ExportFinance,
  GetMarginReport,
  GetMoneyOverview,
  GetOrderMoney,
  ReconcileLedger,
  RecomputeBalances,
  StaleDeliveries,
} from '@/modules/payouts/application/money-reports';
import { RefundOrder } from '@/modules/payouts/application/refunds';
import { recordPayment } from '@/modules/payouts/application/record-payment';
import {
  registerDelivery,
  ReleaseDelivery,
  RetrySettlements,
  SettleOrder,
} from '@/modules/payouts/application/settlement';
import { RequestWithdrawal, ResolveWithdrawals } from '@/modules/payouts/application/withdrawals';
import type { FinanceExportStorage, MoneyProvider } from '@/modules/payouts/application/ports';
import { StripeMoneyAdapter } from '@/modules/payouts/infrastructure/stripe-money-adapter';
import { SupabaseFinanceExports } from '@/modules/payouts/infrastructure/supabase-finance-exports';
import { applyShipmentFactTx } from '@/modules/shipping/application/apply-fact';
import { IngestPaymentEvent } from './ingest-payment-event';
import { IngestShipmentEvent, JOB_CREATE_SHIPMENT_DRAFT } from './ingest-shipment-event';
import { NotificationContextLoaderImpl } from './notification-context';
import { registerU4Jobs } from './u4-jobs';
import { registerU5Jobs } from './u5-jobs';
import {
  ConfirmOperatorLink,
  RequestOperatorLink,
  SendOperatorLink,
  VerifyOperatorTotp,
  type OperatorDirectory,
} from '@/modules/operator/application/access';
import {
  AddNote,
  CloseFlag,
  GetMetrics,
  GetOperatorSummary,
  GetOrderDetail,
  GetSizeSettings,
  ListOrders,
  ListPendingDrafts,
  OpenFlag,
  OperatorRefund,
  OperatorRelease,
  RecordVisit,
  RetryDraft,
  SaveSizeSettings,
} from '@/modules/operator/application/panel';
import { OperatorSessions } from '@/modules/operator/infrastructure/operator-sessions';
import { registerU6Jobs } from './u6-jobs';
import { registerU7Jobs } from './u7-jobs';
import { GetHealth, SecurityAlerts } from '@/modules/operator/application/monitoring';
import { ErasePersonalData, PurgePersonalData } from '@/modules/operator/application/privacy';
import { quotasReviewedAtMs } from '@/modules/operator/domain/quota-review';

import { registerU3Jobs } from './u3-jobs';
import { createAppRepos } from './pg-repos';
import { PgWebhookEventStore } from './pg-webhook-store';
import type { AppRepos } from './repos';

const SUPABASE_ORIGIN = 'https://*.supabase.co';

/** Servicios del panel del operador (U6). */
export type OperatorServices = {
  readonly sessions: OperatorSessions;
  readonly directory: OperatorDirectory;
  readonly requestLink: RequestOperatorLink;
  readonly confirmLink: ConfirmOperatorLink;
  readonly verifyTotp: VerifyOperatorTotp;
  readonly listOrders: ListOrders;
  readonly orderDetail: GetOrderDetail;
  readonly drafts: ListPendingDrafts;
  readonly summary: GetOperatorSummary;
  readonly retryDraft: RetryDraft;
  readonly openFlag: OpenFlag;
  readonly closeFlag: CloseFlag;
  readonly addNote: AddNote;
  readonly release: OperatorRelease;
  readonly refund: OperatorRefund;
  readonly sizes: GetSizeSettings;
  readonly saveSizes: SaveSizeSettings;
  readonly metrics: GetMetrics;
  readonly health: GetHealth;
  readonly erase: ErasePersonalData;
};

/** Servicios de la aplicacion ya cableados (raiz de composicion de U2). */
export type Services = {
  readonly runtime: Runtime;
  readonly auth: AuthPort;
  readonly payout: PayoutProvider;
  readonly storage: PhotoStorage;
  readonly signIn: SignInService;
  readonly accounts: AccountService;
  readonly listings: ListingService;
  readonly photos: PhotoService;
  readonly reservations: ReservationService;
  readonly apply: ApplyAccountEventUseCase;
  readonly ingest: IngestAccountEvent;
  readonly jobs: JobQueue;
  readonly sessions: SessionResolverImpl;
  // U3
  readonly payments: PaymentProvider;
  readonly shipping: ShippingProvider;
  readonly quote: QuoteShipping;
  readonly startCheckout: StartCheckout;
  readonly cancelCheckout: CancelCheckout;
  readonly tracking: GetTracking;
  readonly success: GetSuccessView;
  readonly artistOrders: ListArtistOrders;
  readonly confirmManual: ConfirmManualPayment;
  readonly contacts: ArtistContactService;
  readonly processPayment: ProcessPaymentFact;
  readonly ingestPayment: IngestPaymentEvent;
  readonly manualEnabled: boolean;
  // U4
  readonly ingestShipment: IngestShipmentEvent;
  readonly chooseDraftPickup: ChooseDraftPickup;
  readonly labelDownload: GetLabelDownload;
  readonly invoice: RenderDraftInvoice;
  readonly artistOrder: GetArtistOrder;
  readonly trackingDetails: GetTrackingDetails;
  // U5
  readonly moneyOverview: GetMoneyOverview;
  readonly orderMoney: GetOrderMoney;
  readonly withdraw: RequestWithdrawal;
  readonly settle: SettleOrder;
  readonly releaseDelivery: ReleaseDelivery;
  readonly refundOrder: RefundOrder;
  readonly marginReport: GetMarginReport;
  readonly exportFinance: ExportFinance;
  readonly payoutMode: 'manual' | 'automatico';
  // U6
  readonly operator: OperatorServices | undefined;
  readonly recordVisit: RecordVisit;
  readonly recentLoginMinutes: number;
  /** Solo con E2E_ENABLED. */
  readonly e2e:
    | {
        readonly auth: FakeAuth;
        readonly payout: FakePayoutProvider;
        readonly payment: FakePaymentProvider;
        readonly shipments: FakeShipmentProvider;
        readonly email: FakeEmailSender;
        readonly labels: FakeLabelStorage;
        readonly processShipmentFact: ProcessShipmentFact;
        readonly money: FakeMoneyProvider;
      }
    | undefined;
  readonly secureCookies: boolean;
};

const g = globalThis as unknown as { __marketlinkServices?: Services };

export const getServices = (): Services | undefined => {
  if (g.__marketlinkServices) return g.__marketlinkServices;
  const runtime = getRuntime();
  if (!runtime) return undefined;
  const { config, logger, db, audit, limiter, http } = runtime;
  const clock = systemClock;
  const runner = new PgTransactionRunner<AppRepos>(
    db,
    createAppRepos({ clock, ids: uuidGenerator }),
  );

  let auth: AuthPort;
  let payout: PayoutProvider;
  let storage: PhotoStorage;
  let payments: PaymentProvider;
  let shipping: ShippingProvider;
  let shipmentProvider: ShipmentProvider;
  let emailSender: EmailSender;
  let labelStorage: LabelStorage;
  let money: MoneyProvider;
  let financeStorage: FinanceExportStorage;
  let fakeMoney: FakeMoneyProvider | undefined;
  let e2eParts:
    | { shipments: FakeShipmentProvider; email: FakeEmailSender; labels: FakeLabelStorage }
    | undefined;
  let e2e: Pick<NonNullable<Services['e2e']>, 'auth' | 'payout' | 'payment'> | undefined;
  if (config.e2eEnabled || !config.supabase || !config.stripe) {
    // Modo de pruebas (la configuracion lo rechaza en live): dobles en proceso.
    const fakeAuth = new FakeAuth();
    const fakePayout = new FakePayoutProvider(config.appUrl, () => Date.now());
    auth = fakeAuth;
    payout = fakePayout;
    storage = new MemoryPhotoStorage();
    const fakePayment = new FakePaymentProvider(config.appUrl);
    payments = fakePayment;
    shipping = new FakeShippingProvider();
    fakeMoney = new FakeMoneyProvider();
    money = fakeMoney;
    financeStorage = new FakeFinanceStorage();
    e2e = { auth: fakeAuth, payout: fakePayout, payment: fakePayment };
  } else {
    auth = new SupabaseAuthAdapter({
      url: config.supabase.url,
      publishableKey: config.supabase.publishableKey,
      serviceRoleKey: config.supabase.serviceRoleKey.reveal(),
      fetch: createResilientFetch(http, 'supabase', 'auth'),
      appUrl: config.appUrl,
    });
    storage = new SupabasePhotoStorage({
      url: config.supabase.url,
      serviceRoleKey: config.supabase.serviceRoleKey.reveal(),
      fetch: createResilientFetch(http, 'supabase', 'storage'),
    });
    payout = new StripePayoutAdapter({
      secretKey: config.stripe.secretKey.reveal(),
      apiVersion: config.stripe.apiVersion,
      connectWebhookSecret: config.stripe.connectWebhookSecret.reveal(),
      fetch: createResilientFetch(http, 'stripe', 'api'),
      now: () => Date.now(),
      manualPayouts: config.money.payoutMode === 'manual',
    });
    payments = new StripePaymentAdapter({
      secretKey: config.stripe.secretKey.reveal(),
      apiVersion: config.stripe.apiVersion,
      platformWebhookSecret: config.stripe.platformWebhookSecret.reveal(),
      fetch: createResilientFetch(http, 'stripe', 'checkout'),
    });
    money = new StripeMoneyAdapter({
      secretKey: config.stripe.secretKey.reveal(),
      apiVersion: config.stripe.apiVersion,
      fetch: createResilientFetch(http, 'stripe', 'money'),
      // NFR-U5: la retirada tiene un limite de 10 s y no se reintenta dentro de la peticion.
      payoutFetch: createResilientFetch(http, 'stripe', 'payout', {
        timeoutMs: 10_000,
        maxRetries: 0,
      }),
    });
    financeStorage = new SupabaseFinanceExports({
      url: config.supabase.url,
      serviceRoleKey: config.supabase.serviceRoleKey.reveal(),
      fetch: createResilientFetch(http, 'supabase', 'storage'),
    });
    shipping = config.packlink
      ? new PacklinkShippingAdapter({
          apiKey: config.packlink.apiKey.reveal(),
          // NFR-U3-02: 5 s por intento y un reintento.
          fetch: createResilientFetch(http, 'packlink', 'quote', {
            timeoutMs: 5_000,
            maxRetries: 1,
          }),
        })
      : new FakeShippingProvider();
  }
  if (!config.e2eEnabled && config.packlink && config.email && config.supabase) {
    shipmentProvider = new PacklinkShipmentAdapter({
      apiKey: config.packlink.apiKey.reveal(),
      // NFR-U4-06: consultas 5 s y un reintento; borrador 15 s.
      fetch: createResilientFetch(http, 'packlink', 'shipments', {
        timeoutMs: 5_000,
        maxRetries: 1,
      }),
      writeFetch: createResilientFetch(http, 'packlink', 'draft', {
        timeoutMs: 15_000,
        maxRetries: 1,
      }),
    });
    emailSender = new ResendEmailSender({
      apiKey: config.email.apiKey.reveal(),
      from: config.email.from,
      sandboxRedirect: config.email.sandboxRedirect,
      fetch: createResilientFetch(http, 'resend', 'emails', { timeoutMs: 10_000 }),
    });
    labelStorage = new SupabaseLabelStorage({
      url: config.supabase.url,
      serviceRoleKey: config.supabase.serviceRoleKey.reveal(),
      fetch: createResilientFetch(http, 'supabase', 'storage'),
    });
  } else {
    // Modo de pruebas (la configuracion lo rechaza en live): dobles en proceso.
    const shipments = new FakeShipmentProvider();
    const email = new FakeEmailSender();
    const labels = new FakeLabelStorage(config.appUrl);
    shipmentProvider = shipments;
    emailSender = email;
    labelStorage = labels;
    e2eParts = { shipments, email, labels };
  }
  const processor: ImageProcessor = new SharpImageProcessor();
  const secureCookies = config.appUrl.startsWith('https://');

  const apply = new ApplyAccountEventUseCase({ runner, clock, logger });
  const photos = new PhotoService({
    runner,
    storage,
    processor,
    limiter,
    ids: uuidGenerator,
    clock,
    logger,
  });
  const accounts = new AccountService({
    runner,
    limiter,
    payoutProvider: payout,
    applier: apply,
    clock,
    logger,
    appUrl: config.appUrl,
  });

  const registry = createRegistry(db);
  const jobs = new JobQueue({
    store: new PgJobStore(db),
    registry,
    clock,
    logger,
    audit,
    notifier: runtime.notifier,
  });
  const webhookStore = new PgWebhookEventStore(db);
  const enqueue = (input: { type: string; payload: Record<string, unknown>; dedupeKey: string }) =>
    jobs.enqueue(input);
  const alerts = new AuditLogOperatorAlerts(audit, runtime.notifier);
  const secrets = {
    current: config.tracking.secret.reveal(),
    previous: config.tracking.previousSecret?.reveal(),
  };
  // BR3-MN5: sin politica de importe, el modo manual solo existe en pruebas (E2E).
  const manualPolicy: ManualPaymentPolicy | undefined = config.e2eEnabled
    ? { amountDueCents: (o) => o.totalCents }
    : undefined;
  const manualEnabled = config.flags.paymentManualEnabled && manualPolicy !== undefined;
  const onOrderPaid = new OnOrderPaid({
    runner,
    clock,
    ids: uuidGenerator,
    enqueueDraft: (orderId) =>
      enqueue({
        type: JOB_CREATE_SHIPMENT_DRAFT,
        payload: { orderId },
        dedupeKey: `shipment-draft:${orderId}`,
      }),
  });
  const processPayment = new ProcessPaymentFact({
    runner,
    clock,
    audit,
    alerts,
    logger,
    provider: payments,
    onPaid: (orderId) => onOrderPaid.execute(orderId),
    inTxPaid: (repos, order, now) => recordPayment(repos as AppRepos, order, now),
  });
  const onDelivered = (repos: unknown, order: Order, now: Instant): Promise<void> =>
    registerDelivery(repos as AppRepos, uuidGenerator, order, now);
  const processShipmentFact = new ProcessShipmentFact({
    runner,
    provider: shipmentProvider,
    storage: labelStorage,
    alerts,
    clock,
    ids: uuidGenerator,
    logger,
    onDelivered,
  });
  const documentDeps = {
    runner,
    storage: labelStorage,
    renderer: new PdfLibInvoiceRenderer(),
    audit,
    clock,
    platformName: config.appName,
  };
  const dispatch = new DispatchNotifications({
    runner,
    sender: emailSender,
    loader: new NotificationContextLoaderImpl({
      runner,
      appUrl: config.appUrl,
      brand: config.appName,
      operatorEmail: config.email?.operator ?? 'operador@example.com',
      secrets,
    }),
    clock,
    logger,
    onFailed: (n, correlationId) =>
      alerts.raise(
        'email_fallido',
        n.orderId !== undefined ? { orderId: n.orderId } : { detail: n.type },
        correlationId,
      ),
  });
  registerU4Jobs(registry, {
    draft: new CreateShipmentDraft({
      runner,
      provider: shipmentProvider,
      alerts,
      audit,
      clock,
      ids: uuidGenerator,
    }),
    processFact: processShipmentFact,
    poll: new PollShipments({
      runner,
      provider: shipmentProvider,
      processor: processShipmentFact,
      clock,
    }),
    dispatch,
    remindPickup: new RemindPickup({ runner, alerts, clock, ids: uuidGenerator }),
    remindPay: new RemindPayLabel({ runner, alerts, clock, ids: uuidGenerator }),
    purge: new PurgeLabelsAndNotifications({
      runner,
      storage: labelStorage,
      audit,
      clock,
      labelDays: config.retention.labelDays,
      labelUndeliveredDays: config.retention.labelUndeliveredDays,
      notificationMonths: config.retention.notificationMonths,
    }),
    markProcessed: (eventId) => webhookStore.markProcessed('packlink', eventId),
  });
  // U5: dinero
  const moneyDeps = { runner, clock, ids: uuidGenerator, audit, alerts, logger };
  const settle = new SettleOrder({
    ...moneyDeps,
    provider: money,
    settlementDelayHours: config.money.settlementDelayHours,
    blockedAlertDays: config.money.blockedAlertDays,
  });
  const withdrawalDeps = {
    ...moneyDeps,
    provider: money,
    mode: config.money.payoutMode,
    recentLoginMinutes: config.money.recentLoginMinutes,
    limiter,
  };
  const withdraw = new RequestWithdrawal(withdrawalDeps);
  const jobDeps = { runner, clock, audit, alerts, logger };
  registerU5Jobs(registry, {
    retrySettlements: new RetrySettlements({
      ...moneyDeps,
      provider: money,
      settlementDelayHours: config.money.settlementDelayHours,
      blockedAlertDays: config.money.blockedAlertDays,
      settle,
    }),
    resolveWithdrawals: new ResolveWithdrawals({ ...withdrawalDeps, requests: withdraw }),
    reconcile: new ReconcileLedger(jobDeps),
    recompute: new RecomputeBalances(jobDeps),
    stale: new StaleDeliveries({ ...jobDeps, staleDays: config.money.staleDeliveryDays }),
    exportFinance: new ExportFinance({ ...jobDeps, storage: financeStorage }),
  });
  const handleCharge = new HandleChargeEvent({ runner, audit, alerts });
  const quote = new QuoteShipping({ runner, shipping, limiter, alerts, clock, logger });
  const queryDeps = { runner, limiter, clock, secrets, manualPolicy };
  registerU3Jobs(registry, {
    processor: processPayment,
    refund: new RefundPayment({ runner, provider: payments, clock, audit, alerts }),
    expire: new ExpireStaleOrders({
      runner,
      provider: payments,
      processor: processPayment,
      clock,
      logger,
    }),
    reconcile: new ReconcileStripe({ runner, provider: payments, clock, audit, alerts, logger }),
    purge: new PurgeUnpaidOrders({
      runner,
      clock,
      audit,
      retentionDays: config.retention.unpaidDays,
    }),
    enqueue,
    markProcessed: (eventId) => webhookStore.markProcessed('stripe', eventId),
    logger,
    chargeEvent: async (raw, correlationId) => {
      const event = parsePaymentEvent(raw);
      if (event) await handleCharge.execute(event, correlationId);
    },
  });
  registerU2Jobs(registry, {
    apply,
    photos,
    enqueue,
    notifier: runtime.notifier,
    markProcessed: (eventId) => webhookStore.markProcessed('stripe', eventId),
    logger,
  });

  const releaseDelivery = new ReleaseDelivery({
    ...moneyDeps,
    provider: money,
    settlementDelayHours: config.money.settlementDelayHours,
    blockedAlertDays: config.money.blockedAlertDays,
    settle,
    markDelivered: async (repos, order, now) => {
      const r = repos as AppRepos;
      const shipment = await r.shipments.findByOrderForUpdate(order.id);
      if (!shipment) return 'unchanged';
      const applied = await applyShipmentFactTx(
        r,
        uuidGenerator,
        order,
        shipment,
        { type: 'delivered', at: now },
        now,
        onDelivered,
      );
      return applied.order.status === 'entregado' ? 'delivered' : 'unchanged';
    },
  });
  const refundOrder = new RefundOrder({ ...moneyDeps, provider: money });

  // U7: limpieza de datos personales y alertas de seguridad (no dependen del panel).
  const purgePersonal = new PurgePersonalData({
    runner,
    clock,
    audit,
    alerts,
    logger,
    months: config.retention.personalMonths,
  });
  registerU7Jobs(registry, {
    purge: purgePersonal,
    security: new SecurityAlerts({
      runner,
      clock,
      alerts,
      audit,
      enqueue,
      logger,
      thresholds: {
        authFailures: config.alerts.authFailures,
        authzDenied: config.alerts.authzDenied,
        webhookSignatures: config.alerts.webhookSignatures,
      },
    }),
  });

  // U6: panel del operador (solo si esta configurado; en live es obligatorio).
  let operator: OperatorServices | undefined;
  if (config.operator) {
    const ops = config.operator;
    const directory: OperatorDirectory = {
      isAuthorized: (e) => ops.emails.includes(e.trim().toLowerCase()),
      totpSecret: (e) => ops.totpSecrets.get(e.trim().toLowerCase())?.reveal(),
      all: () => ops.emails,
    };
    const opSessions = new OperatorSessions({
      secret: ops.sessionSecret.reveal(),
      directory,
      clock,
      secure: secureCookies,
    });
    const accessDeps = {
      auth,
      directory,
      runner,
      limiter,
      audit,
      alerts,
      enqueue,
      clock,
      logger,
    };
    const verifyTotp = new VerifyOperatorTotp(accessDeps);
    const sendLink = new SendOperatorLink(accessDeps);
    const panelDeps = {
      runner,
      directory,
      limiter,
      audit,
      clock,
      ids: uuidGenerator,
      logger,
      staleDays: config.money.staleDeliveryDays,
      totp: verifyTotp,
      draft: new CreateShipmentDraft({
        runner,
        provider: shipmentProvider,
        alerts,
        audit,
        clock,
        ids: uuidGenerator,
      }),
      release: releaseDelivery,
      refund: refundOrder,
    };
    registerU6Jobs(registry, {
      sendLink,
      directory,
      email: emailSender,
      appName: config.appName,
      runner,
      clock,
    });
    operator = {
      sessions: opSessions,
      directory,
      requestLink: new RequestOperatorLink(accessDeps),
      confirmLink: new ConfirmOperatorLink(accessDeps),
      verifyTotp,
      listOrders: new ListOrders(panelDeps),
      orderDetail: new GetOrderDetail(panelDeps),
      drafts: new ListPendingDrafts(panelDeps),
      summary: new GetOperatorSummary(panelDeps),
      retryDraft: new RetryDraft(panelDeps),
      openFlag: new OpenFlag(panelDeps),
      closeFlag: new CloseFlag(panelDeps),
      addNote: new AddNote(panelDeps),
      release: new OperatorRelease(panelDeps),
      refund: new OperatorRefund(panelDeps),
      sizes: new GetSizeSettings(panelDeps),
      saveSizes: new SaveSizeSettings(panelDeps),
      metrics: new GetMetrics(panelDeps),
      health: new GetHealth({
        runner,
        directory,
        clock,
        logger,
        staleDays: config.money.staleDeliveryDays,
        circuits: () =>
          (['stripe', 'packlink', 'resend', 'supabase'] as const).map((provider) => ({
            provider,
            state: http.circuit(provider).state(),
          })),
        quotasReviewedAt: quotasReviewedAtMs,
        live: config.environment === 'live',
      }),
      erase: new ErasePersonalData({ purge: purgePersonal, directory, totp: verifyTotp, limiter }),
    };
  }
  const recordVisit = new RecordVisit({ runner, limiter, clock, logger });

  g.__marketlinkServices = {
    runtime,
    auth,
    payout,
    storage,
    signIn: new SignInService({ auth, runner, limiter, audit, clock, logger }),
    accounts,
    listings: new ListingService({
      runner,
      storage,
      limiter,
      audit,
      random: secureRandom,
      ids: uuidGenerator,
      clock,
      logger,
      appUrl: config.appUrl,
    }),
    photos,
    reservations: new ReservationService({ runner, ids: uuidGenerator, clock }),
    apply,
    ingest: new IngestAccountEvent({
      provider: payout,
      store: webhookStore,
      enqueue,
      audit,
      logger,
    }),
    jobs,
    payments,
    shipping,
    quote,
    startCheckout: new StartCheckout({
      runner,
      quoter: quote,
      provider: payments,
      limiter,
      alerts,
      audit,
      clock,
      ids: uuidGenerator,
      logger,
      appUrl: config.appUrl,
      secrets,
      sessionMinutes: config.checkout.sessionMinutes,
      reservationMinutes: config.checkout.reservationMinutes,
      manualReservationHours: 24,
      bizumEnabled: config.flags.bizumEnabled,
      manualEnabled,
      manualPolicy,
    }),
    cancelCheckout: new CancelCheckout({
      runner,
      provider: payments,
      processor: processPayment,
      clock,
      audit,
    }),
    tracking: new GetTracking(queryDeps),
    success: new GetSuccessView(queryDeps),
    artistOrders: new ListArtistOrders({ runner, clock }),
    confirmManual: new ConfirmManualPayment({
      ...queryDeps,
      audit,
      manualEnabled,
      onPaid: (orderId) => onOrderPaid.execute(orderId),
    }),
    contacts: new ArtistContactService({ runner, limiter, clock }),
    processPayment,
    ingestPayment: new IngestPaymentEvent({
      provider: payments,
      store: webhookStore,
      enqueue,
      audit,
      logger,
    }),
    manualEnabled,
    ingestShipment: new IngestShipmentEvent({
      secret: config.packlink?.webhookSecret,
      store: webhookStore,
      enqueue,
      audit,
      logger,
      clock,
    }),
    chooseDraftPickup: new ChooseDraftPickup({
      runner,
      provider: shipmentProvider,
      clock,
      enqueue: (orderId) =>
        enqueue({
          type: JOB_CREATE_SHIPMENT_DRAFT,
          payload: { orderId },
          dedupeKey: `shipment-draft:${orderId}:${clock.now()}`,
        }),
    }),
    labelDownload: new GetLabelDownload(documentDeps),
    invoice: new RenderDraftInvoice(documentDeps),
    artistOrder: new GetArtistOrder({ runner, clock }),
    trackingDetails: new GetTrackingDetails({ base: new GetTracking(queryDeps), runner }),
    moneyOverview: new GetMoneyOverview({ runner, mode: config.money.payoutMode }),
    orderMoney: new GetOrderMoney({ runner }),
    withdraw,
    settle,
    releaseDelivery,
    refundOrder,
    marginReport: new GetMarginReport({ runner }),
    exportFinance: new ExportFinance({ ...jobDeps, storage: financeStorage }),
    payoutMode: config.money.payoutMode,
    operator,
    recordVisit,
    recentLoginMinutes: config.money.recentLoginMinutes,
    sessions: new SessionResolverImpl({
      auth,
      cookieSecret: config.sessionCookieSecret.reveal(),
      clock,
      logger,
      secureCookies,
    }),
    e2e:
      e2e && e2eParts && fakeMoney
        ? { ...e2e, ...e2eParts, processShipmentFact, money: fakeMoney }
        : undefined,
    secureCookies,
  };
  return g.__marketlinkServices;
};

/** Entrada del proxy: si la configuracion no es valida, falla cerrado con 503 generico. */
export const handleRequest = async (req: NextRequest): Promise<NextResponse> => {
  const services = getServices();
  if (!services) {
    const body = toErrorResponse(appError('dependency_unavailable'), 'config-invalid');
    const res = NextResponse.json(body.body, { status: body.status, headers: body.headers });
    for (const [k, v] of Object.entries(securityHeaders({ nonce: generateNonce() }))) {
      res.headers.set(k, v);
    }
    return res;
  }
  const { runtime, sessions } = services;
  const pipeline = createPipeline({
    table: ROUTE_TABLE,
    sessions,
    operatorSessions: services.operator?.sessions,
    limiter: runtime.limiter,
    errors: runtime.errors,
    logger: runtime.logger,
    isDev: process.env.NODE_ENV === 'development',
    imgSources: [SUPABASE_ORIGIN],
    connectSources: [SUPABASE_ORIGIN],
  });
  return pipeline(req);
};
