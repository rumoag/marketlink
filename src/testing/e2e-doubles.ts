import { randomBytes, randomUUID } from 'node:crypto';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Email } from '@/modules/kernel/domain/formats';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type {
  AuthPort,
  AuthSession,
  ConnectEvent,
  PayoutProvider,
} from '@/modules/accounts/application/ports';
import type { AccountSnapshot } from '@/modules/accounts/domain/payout';
import type { PhotoStorage } from '@/modules/listings/application/ports';
import type {
  CheckoutSession,
  CreateSessionInput,
  PaidSession,
  PaymentEvent,
  PaymentProvider,
} from '@/modules/orders/application/ports';
import type { ShippingProvider, ShippingQuoteRequest } from '@/modules/checkout/application/ports';
import { instantOf } from '@/modules/kernel/domain/clock';
import type { EmailMessage, EmailSender } from '@/modules/notifications/application/ports';
import type {
  DraftInput,
  LabelStorage,
  ShipmentProvider,
} from '@/modules/shipping/application/ports';
import type { DropoffPoint, PickupOption, ShipmentFact } from '@/modules/shipping/domain/shipment';
import type { ShippingService } from '@/modules/checkout/domain/quote';
import type { FinanceExportStorage, MoneyProvider } from '@/modules/payouts/application/ports';

/**
 * Dobles en proceso de Supabase Auth/Storage y Stripe para pruebas de extremo a extremo.
 * Solo se activan con E2E_ENABLED, que la configuracion rechaza en `live`. Comparten estado por
 * proceso (globalThis) porque Next.js puede cargar cada ruta en un modulo distinto.
 */
type E2EState = {
  magicLinks: Map<string, Email>; // tokenHash -> email
  users: Map<string, string>; // email -> userId
  access: Map<string, { userId: string; email: Email }>;
  refresh: Map<string, { userId: string; email: Email }>;
  objects: Map<string, Uint8Array>;
  accounts: Map<string, AccountSnapshot>;
  /** Cuentas con activacion lenta (como Stripe): id -> instante en que pasan a activas (0 = sin onboarding). */
  slowAccounts: Map<string, number>;
};

const g = globalThis as unknown as { __marketlinkE2E?: E2EState };
const state = (): E2EState =>
  (g.__marketlinkE2E ??= {
    magicLinks: new Map(),
    users: new Map(),
    access: new Map(),
    refresh: new Map(),
    objects: new Map(),
    accounts: new Map(),
    slowAccounts: new Map(),
  });

const token = (): string => randomBytes(24).toString('base64url');

export class FakeAuth implements AuthPort {
  /** Solo pruebas: emite un enlace de acceso valido sin enviar correo. */
  issueMagicLink(email: Email): string {
    const tokenHash = token();
    state().magicLinks.set(tokenHash, email);
    return tokenHash;
  }

  requestMagicLink(email: Email): Promise<Result<void, AppError>> {
    this.issueMagicLink(email);
    return Promise.resolve(ok(undefined));
  }

  verifySignIn(tokenHash: string): Promise<Result<AuthSession, AppError>> {
    const s = state();
    const email = s.magicLinks.get(tokenHash);
    s.magicLinks.delete(tokenHash); // un solo uso
    if (!email) return Promise.resolve(err(appError('unauthenticated')));
    return Promise.resolve(ok(this.openSession(email)));
  }

  verifyAccessToken(accessToken: string): Promise<{ userId: string; email: Email } | null> {
    return Promise.resolve(state().access.get(accessToken) ?? null);
  }

  refresh(refreshToken: string): Promise<Result<AuthSession, AppError>> {
    const s = state();
    const identity = s.refresh.get(refreshToken);
    if (!identity) return Promise.resolve(err(appError('unauthenticated')));
    s.refresh.delete(refreshToken); // rotatorio
    return Promise.resolve(ok(this.openSession(identity.email)));
  }

  signOut(accessToken: string): Promise<void> {
    const s = state();
    const identity = s.access.get(accessToken);
    s.access.delete(accessToken);
    if (identity) {
      for (const [rt, who] of s.refresh) if (who.userId === identity.userId) s.refresh.delete(rt);
    }
    return Promise.resolve();
  }

  /** Solo pruebas: identificador del artista de un email (tras haber entrado una vez). */
  userIdForEmail(email: string): string | undefined {
    return state().users.get(email);
  }

  /** Solo pruebas: invalida el token de acceso para forzar el camino de renovacion. */
  expireAccessTokens(): void {
    state().access.clear();
  }

  private openSession(email: Email): AuthSession {
    const s = state();
    let userId = s.users.get(email);
    if (!userId) {
      userId = randomUUID();
      s.users.set(email, userId);
    }
    const accessToken = token();
    const refreshToken = token();
    s.access.set(accessToken, { userId, email });
    s.refresh.set(refreshToken, { userId, email });
    return { userId, email, accessToken, refreshToken };
  }
}

const ENABLED: Omit<AccountSnapshot, 'eventAt'> = {
  detailsSubmitted: true,
  transfersActive: true,
  payoutsEnabled: true,
  disabled: false,
};

/** Estado de una cuenta que ya envio sus datos y espera a que Stripe active las capacidades. */
const VERIFYING: Omit<AccountSnapshot, 'eventAt'> = {
  detailsSubmitted: true,
  transfersActive: false,
  payoutsEnabled: false,
  disabled: false,
};

/** Lo que tarda en activarse una cuenta «lenta» (simula la demora real de Stripe). */
export const SLOW_ACTIVATION_MS = 8_000;
/** Los correos de artista que empiezan asi crean cuentas de activacion lenta (solo pruebas). */
export const SLOW_ACCOUNT_EMAIL_PREFIX = 'lento-';

/**
 * Cuenta de cobros simulada: al crear el enlace de onboarding queda habilitada, salvo las cuentas
 * «lentas» (correo que empieza por `lento-`), que tardan unos segundos como en Stripe real.
 */
export class FakePayoutProvider implements PayoutProvider {
  constructor(
    private readonly appUrl: string,
    private readonly now: () => number,
  ) {}

  createAccount(input: {
    artistId: string;
    email?: string;
  }): Promise<Result<{ providerAccountId: string }, AppError>> {
    const id = `acct_fake_${input.artistId.slice(0, 8)}`;
    if (input.email?.startsWith(SLOW_ACCOUNT_EMAIL_PREFIX)) state().slowAccounts.set(id, 0);
    state().accounts.set(id, {
      detailsSubmitted: false,
      transfersActive: false,
      payoutsEnabled: false,
      disabled: false,
      eventAt: this.now(),
    });
    return Promise.resolve(ok({ providerAccountId: id }));
  }

  createOnboardingLink(providerAccountId: string): Promise<Result<{ url: string }, AppError>> {
    if (state().slowAccounts.has(providerAccountId)) {
      state().slowAccounts.set(providerAccountId, this.now() + SLOW_ACTIVATION_MS);
      state().accounts.set(providerAccountId, { ...VERIFYING, eventAt: this.now() });
    } else {
      state().accounts.set(providerAccountId, { ...ENABLED, eventAt: this.now() });
    }
    return Promise.resolve(ok({ url: `${this.appUrl}/artista/cobros?onboarding=simulado` }));
  }

  getAccountSnapshot(providerAccountId: string): Promise<Result<AccountSnapshot, AppError>> {
    const slowUntil = state().slowAccounts.get(providerAccountId);
    if (slowUntil !== undefined && slowUntil > 0 && this.now() >= slowUntil) {
      state().slowAccounts.delete(providerAccountId);
      state().accounts.set(providerAccountId, { ...ENABLED, eventAt: this.now() });
    }
    const snapshot = state().accounts.get(providerAccountId);
    if (!snapshot) return Promise.resolve(err(appError('not_found')));
    return Promise.resolve(ok({ ...snapshot, eventAt: this.now() }));
  }

  parseEvent(): Result<ConnectEvent | null, 'invalid_signature'> {
    return err('invalid_signature'); // en modo de pruebas los eventos entran por /api/test
  }

  /** Solo pruebas: cambia el estado simulado de la cuenta. */
  setSnapshot(providerAccountId: string, patch: Partial<AccountSnapshot>): void {
    const current = state().accounts.get(providerAccountId);
    if (current) state().accounts.set(providerAccountId, { ...current, ...patch });
  }
}

/** Almacenamiento en memoria; las URL "firmadas" son data URLs para no exponer una ruta extra. */
export class MemoryPhotoStorage implements PhotoStorage {
  put(key: string, bytes: Uint8Array): Promise<Result<void, AppError>> {
    state().objects.set(key, bytes);
    return Promise.resolve(ok(undefined));
  }

  remove(keys: readonly string[]): Promise<Result<void, AppError>> {
    for (const key of keys) state().objects.delete(key);
    return Promise.resolve(ok(undefined));
  }

  signUrls(keys: readonly string[]): Promise<Result<ReadonlyMap<string, string>, AppError>> {
    const map = new Map<string, string>();
    for (const key of keys) {
      const bytes = state().objects.get(key);
      if (bytes) map.set(key, `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`);
    }
    return Promise.resolve(ok(map));
  }
}

// ---------------------------------------------------------------------------------------------
// U3: pago y envio simulados (solo con E2E_ENABLED; la configuracion lo rechaza en live)
// ---------------------------------------------------------------------------------------------
type FakeSession = {
  id: string;
  orderId: string;
  amountCents: number;
  status: 'abierta' | 'completada' | 'expirada';
  paid: boolean;
  paymentIntentId: string;
  successUrl: string;
  cancelUrl: string;
  methods: readonly string[];
  createdAt: number;
};

type PayState = { sessions: Map<string, FakeSession>; refunds: Map<string, string> };
const gp = globalThis as unknown as { __marketlinkE2EPay?: PayState };
const payState = (): PayState =>
  (gp.__marketlinkE2EPay ??= { sessions: new Map(), refunds: new Map() });

const toSession = (s: FakeSession, appUrl: string): CheckoutSession => ({
  id: s.id,
  url: s.status === 'abierta' ? `${appUrl}/e2e/pago/${s.id}` : undefined,
  status: s.status,
  paid: s.paid,
  paymentIntentId: s.paymentIntentId,
  orderId: s.orderId,
  amountCents: s.amountCents,
});

/** Pago simulado: la «pagina de Stripe» es /e2e/pago/<sesion>, que solo existe con E2E_ENABLED. */
export class FakePaymentProvider implements PaymentProvider {
  constructor(private readonly appUrl: string) {}

  createCheckoutSession(input: CreateSessionInput): Promise<Result<CheckoutSession, AppError>> {
    const existing = [...payState().sessions.values()].find((s) => s.orderId === input.orderId);
    if (existing) return Promise.resolve(ok(toSession(existing, this.appUrl)));
    const id = `cs_test_${randomBytes(12).toString('hex')}`;
    const session: FakeSession = {
      id,
      orderId: input.orderId,
      amountCents: input.workPriceCents + input.shippingCents,
      status: 'abierta',
      paid: false,
      paymentIntentId: `pi_test_${randomBytes(8).toString('hex')}`,
      successUrl: input.successUrl.replace('{CHECKOUT_SESSION_ID}', id),
      cancelUrl: input.cancelUrl,
      methods: input.methods,
      createdAt: Date.now(),
    };
    payState().sessions.set(id, session);
    return Promise.resolve(ok(toSession(session, this.appUrl)));
  }

  expireSession(sessionId: string): Promise<Result<CheckoutSession, AppError>> {
    const s = payState().sessions.get(sessionId);
    if (!s) return Promise.resolve(err(appError('not_found')));
    if (s.status === 'abierta') s.status = 'expirada';
    return Promise.resolve(ok(toSession(s, this.appUrl)));
  }

  getSession(sessionId: string): Promise<Result<CheckoutSession, AppError>> {
    const s = payState().sessions.get(sessionId);
    return Promise.resolve(s ? ok(toSession(s, this.appUrl)) : err(appError('not_found')));
  }

  listPaidSessions(): Promise<Result<PaidSession[], AppError>> {
    return Promise.resolve(
      ok(
        [...payState().sessions.values()]
          .filter((s) => s.paid)
          .map((s) => ({
            sessionId: s.id,
            orderId: s.orderId,
            paymentIntentId: s.paymentIntentId,
            amountCents: s.amountCents,
          })),
      ),
    );
  }

  refund(input: { paymentIntentId: string }): Promise<Result<{ refundId: string }, AppError>> {
    const known = payState().refunds.get(input.paymentIntentId);
    const refundId = known ?? `re_test_${randomBytes(6).toString('hex')}`;
    payState().refunds.set(input.paymentIntentId, refundId);
    return Promise.resolve(ok({ refundId }));
  }

  parseEvent(): Result<PaymentEvent | null, 'invalid_signature'> {
    return err('invalid_signature'); // en modo de pruebas los eventos entran por /e2e/pago
  }

  /** Solo pruebas: la compradora paga (o no) en la pagina simulada. */
  settle(sessionId: string, outcome: 'pagar' | 'cancelar' | 'caducar'): FakeSession | undefined {
    const s = payState().sessions.get(sessionId);
    if (!s) return undefined;
    if (outcome === 'pagar' && s.status !== 'completada') {
      s.status = 'completada';
      s.paid = true;
    }
    if (outcome === 'caducar' && s.status === 'abierta') s.status = 'expirada';
    return s;
  }

  /** Solo pruebas: evento equivalente al que enviaria Stripe. */
  eventFor(session: FakeSession, kind: 'completed' | 'expired'): PaymentEvent {
    return {
      id: `evt_test_${randomBytes(8).toString('hex')}`,
      type: kind,
      sessionId: session.id,
      orderId: session.orderId,
      paymentIntentId: session.paymentIntentId,
      paid: kind === 'completed',
      amountCents: session.amountCents,
    };
  }

  get(sessionId: string): FakeSession | undefined {
    return payState().sessions.get(sessionId);
  }
}

/**
 * Cotizacion simulada. Por prefijo del codigo postal de destino (todos peninsulares validos):
 *  - 44 (Teruel): sin servicio en ninguna modalidad; - 42 (Soria): proveedor caido;
 *  - 26 (La Rioja): solo recogida; - resto: punto 4,90 (2 dias), punto 4,50 (3 dias), recogida 6,20.
 */
export class FakeShippingProvider implements ShippingProvider {
  quote(request: ShippingQuoteRequest): Promise<Result<readonly ShippingService[], AppError>> {
    const prefix = request.toPostalCode.slice(0, 2);
    if (prefix === '42') return Promise.resolve(err(appError('dependency_unavailable')));
    if (prefix === '44') return Promise.resolve(ok([]));
    const recogida: ShippingService = {
      id: 'fake-recogida',
      name: 'Recogida a domicilio',
      modality: 'recogida',
      priceCents: 620,
      transitDays: 1,
    };
    if (prefix === '26') return Promise.resolve(ok([recogida]));
    return Promise.resolve(
      ok([
        { id: 'fake-punto-a', name: 'Punto A', modality: 'punto', priceCents: 490, transitDays: 2 },
        { id: 'fake-punto-b', name: 'Punto B', modality: 'punto', priceCents: 450, transitDays: 3 },
        recogida,
      ]),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// U4: envio y correo simulados (solo con E2E_ENABLED)
// ---------------------------------------------------------------------------------------------
type FakeShipment = {
  ref: string;
  reference: string;
  state:
    'borrador' | 'etiqueta' | 'transito' | 'entregado' | 'fallo_etiqueta' | 'fallo_transportista';
  createdAt: number;
};
type ShipState = {
  shipments: Map<string, FakeShipment>;
  labels: Map<string, Uint8Array>;
  emails: { to: string; subject: string; text: string }[];
};
const gs = globalThis as unknown as { __marketlinkE2EShip?: ShipState };
const shipState = (): ShipState =>
  (gs.__marketlinkE2EShip ??= { shipments: new Map(), labels: new Map(), emails: [] });

/** PDF minimo valido (cabecera %PDF) para la etiqueta simulada. */
const TINY_PDF = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
);

/** Packlink simulado: el envio avanza cuando la pagina /e2e/envio/<ref> lo indica. */
export class FakeShipmentProvider implements ShipmentProvider {
  findByReference(
    reference: string,
  ): Promise<Result<{ providerRef: string } | undefined, AppError>> {
    const found = [...shipState().shipments.values()].find((s) => s.reference === reference);
    return Promise.resolve(ok(found ? { providerRef: found.ref } : undefined));
  }

  createDraft(input: DraftInput): Promise<Result<{ providerRef: string }, AppError>> {
    const ref = `PL${input.reference.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    shipState().shipments.set(ref, {
      ref,
      reference: input.reference,
      state: 'borrador',
      createdAt: Date.now(),
    });
    return Promise.resolve(ok({ providerRef: ref }));
  }

  fetchFacts(providerRef: string): Promise<Result<readonly ShipmentFact[], AppError>> {
    const s = shipState().shipments.get(providerRef);
    if (!s) return Promise.resolve(err(appError('not_found')));
    return Promise.resolve(ok(factsForFake(s.state)));
  }

  getLabel(providerRef: string): Promise<Result<Uint8Array, AppError>> {
    return Promise.resolve(
      shipState().shipments.has(providerRef) ? ok(TINY_PDF) : err(appError('not_found')),
    );
  }

  getDropoffs(): Promise<Result<readonly DropoffPoint[], AppError>> {
    return Promise.resolve(
      ok([
        {
          name: 'Papeleria Sol',
          address: 'Calle Sol 1, Madrid',
          schedule: 'L-V 9-20',
          distanceKm: 0.8,
        },
        {
          name: 'Kiosco Luna',
          address: 'Plaza Luna 3, Madrid',
          schedule: 'L-S 8-21',
          distanceKm: 0.3,
        },
        {
          name: 'Estanco Mar',
          address: 'Av. Mar 10, Madrid',
          schedule: 'L-V 10-19',
          distanceKm: 1.4,
        },
        {
          name: 'Libreria Rio',
          address: 'Calle Rio 7, Madrid',
          schedule: 'L-V 10-14',
          distanceKm: 2.2,
        },
      ]),
    );
  }

  getPickupOptions(): Promise<Result<readonly PickupOption[], AppError>> {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const options = [1, 2, 3].flatMap((n) =>
      ['09:00-13:00', '15:00-19:00'].map((slot) => ({
        id: `${day(n)}|${slot}`,
        date: day(n),
        slot,
      })),
    );
    return Promise.resolve(ok(options));
  }

  /** Solo pruebas: hace avanzar el envio simulado. */
  advance(ref: string, state: FakeShipment['state']): FakeShipment | undefined {
    const s = shipState().shipments.get(ref);
    if (s) s.state = state;
    return s;
  }
  get(ref: string): FakeShipment | undefined {
    return shipState().shipments.get(ref);
  }
}

const factsForFake = (state: FakeShipment['state']): ShipmentFact[] => {
  const at = instantOf(Date.now());
  const facts: ShipmentFact[] = [
    { type: 'tracking_info', at, trackingUrl: 'https://carrier.test/seguir/123' },
  ];
  if (state === 'fallo_etiqueta') facts.push({ type: 'label_failed', at });
  else if (state === 'fallo_transportista') facts.push({ type: 'carrier_failed', at });
  else {
    if (state !== 'borrador') facts.push({ type: 'label_ready', at, labelCostCents: 450 });
    if (state === 'transito' || state === 'entregado') facts.push({ type: 'in_transit', at });
    if (state === 'entregado') facts.push({ type: 'delivered', at });
  }
  return facts;
};

export { factsForFake };

/** Correo simulado: guarda los mensajes en memoria para consultarlos en las pruebas. */
export class FakeEmailSender implements EmailSender {
  send(message: EmailMessage): Promise<Result<void, AppError>> {
    shipState().emails.push({ to: message.to, subject: message.subject, text: message.text });
    return Promise.resolve(ok(undefined));
  }
  all(): readonly { to: string; subject: string; text: string }[] {
    return shipState().emails;
  }
}

/** Almacen de etiquetas en memoria; la «URL firmada» apunta a /e2e/etiqueta (solo E2E). */
export class FakeLabelStorage implements LabelStorage {
  constructor(private readonly appUrl: string) {}
  put(key: string, bytes: Uint8Array): Promise<Result<void, AppError>> {
    shipState().labels.set(key, bytes);
    return Promise.resolve(ok(undefined));
  }
  signedUrl(key: string): Promise<Result<string, AppError>> {
    return Promise.resolve(ok(`${this.appUrl}/e2e/etiqueta?key=${encodeURIComponent(key)}`));
  }
  remove(keys: readonly string[]): Promise<Result<void, AppError>> {
    for (const k of keys) shipState().labels.delete(k);
    return Promise.resolve(ok(undefined));
  }
  bytes(key: string): Uint8Array | undefined {
    return shipState().labels.get(key);
  }
}

// ---------------------------------------------------------------------------------------------
// U5: dinero simulado (Stripe Connect) y exportaciones
// ---------------------------------------------------------------------------------------------
type MoneyState = {
  transfers: Map<string, { ref: string; orderId: string; amountCents: number; accountId: string }>;
  payouts: Map<string, { ref: string; accountId: string; amountCents: number; key: string }>;
  refunds: Map<string, { ref: string; paymentIntentId: string; amountCents: number }>;
  exports: Map<string, string>;
  /** Fallos controlables desde las pruebas. */
  failTransfer: 'none' | 'definitive' | 'doubtful';
  failPayout: 'none' | 'definitive' | 'doubtful';
  failRefund: boolean;
};
const gm = globalThis as unknown as { __marketlinkE2EMoney?: MoneyState };
export const moneyState = (): MoneyState =>
  (gm.__marketlinkE2EMoney ??= {
    transfers: new Map(),
    payouts: new Map(),
    refunds: new Map(),
    exports: new Map(),
    failTransfer: 'none',
    failPayout: 'none',
    failRefund: false,
  });

const failureOf = (mode: 'definitive' | 'doubtful'): AppError =>
  appError(mode === 'doubtful' ? 'dependency_unavailable' : 'internal');

export class FakeMoneyProvider implements MoneyProvider {
  chargeOf(
    paymentIntentId: string,
  ): Promise<
    Result<{ chargeId: string; method: 'tarjeta' | 'bizum' | undefined } | undefined, AppError>
  > {
    return Promise.resolve(ok({ chargeId: `ch_fake_${paymentIntentId}`, method: 'tarjeta' }));
  }

  transfer(input: {
    orderId: string;
    destinationAccountId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<Result<{ transferRef: string }, AppError>> {
    const st = moneyState();
    if (st.failTransfer !== 'none') return Promise.resolve(err(failureOf(st.failTransfer)));
    const existing = st.transfers.get(input.idempotencyKey);
    if (existing) return Promise.resolve(ok({ transferRef: existing.ref }));
    const ref = `tr_fake_${st.transfers.size + 1}`;
    st.transfers.set(input.idempotencyKey, {
      ref,
      orderId: input.orderId,
      amountCents: input.amountCents,
      accountId: input.destinationAccountId,
    });
    return Promise.resolve(ok({ transferRef: ref }));
  }

  findTransfer(orderId: string): Promise<Result<{ transferRef: string } | undefined, AppError>> {
    const found = [...moneyState().transfers.values()].find((t) => t.orderId === orderId);
    return Promise.resolve(ok(found ? { transferRef: found.ref } : undefined));
  }

  payout(input: {
    accountId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<Result<{ payoutRef: string }, AppError>> {
    const st = moneyState();
    if (st.failPayout !== 'none') return Promise.resolve(err(failureOf(st.failPayout)));
    const existing = st.payouts.get(input.idempotencyKey);
    if (existing) return Promise.resolve(ok({ payoutRef: existing.ref }));
    const ref = `po_fake_${st.payouts.size + 1}`;
    st.payouts.set(input.idempotencyKey, {
      ref,
      accountId: input.accountId,
      amountCents: input.amountCents,
      key: input.idempotencyKey,
    });
    return Promise.resolve(ok({ payoutRef: ref }));
  }

  findPayout(
    _accountId: string,
    idempotencyKey: string,
  ): Promise<Result<{ payoutRef: string } | undefined, AppError>> {
    const found = moneyState().payouts.get(idempotencyKey);
    return Promise.resolve(ok(found ? { payoutRef: found.ref } : undefined));
  }

  refund(input: {
    paymentIntentId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<Result<{ refundRef: string }, AppError>> {
    const st = moneyState();
    if (st.failRefund) return Promise.resolve(err(appError('dependency_unavailable')));
    const existing = st.refunds.get(input.idempotencyKey);
    if (existing) return Promise.resolve(ok({ refundRef: existing.ref }));
    const ref = `re_fake_${st.refunds.size + 1}`;
    st.refunds.set(input.idempotencyKey, {
      ref,
      paymentIntentId: input.paymentIntentId,
      amountCents: input.amountCents,
    });
    return Promise.resolve(ok({ refundRef: ref }));
  }
}

export class FakeFinanceStorage implements FinanceExportStorage {
  put(key: string, csv: string): Promise<Result<void, AppError>> {
    moneyState().exports.set(key, csv);
    return Promise.resolve(ok(undefined));
  }
}
