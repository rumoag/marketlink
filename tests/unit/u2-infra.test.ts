import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { appError } from '@/modules/kernel/domain/app-error';
import { instantOf, MS } from '@/modules/kernel/domain/clock';
import { Email } from '@/modules/kernel/domain/formats';
import { err, ok, unwrap } from '@/modules/kernel/domain/result';
import type { AuthPort } from '@/modules/accounts/application/ports';
import { SESSION_IDLE_MS } from '@/modules/accounts/domain/session';
import {
  COOKIE_ACCESS,
  COOKIE_ACTIVITY,
  COOKIE_REFRESH,
  buildSessionCookies,
  clearSessionCookies,
  decodeActivityCookie,
  encodeActivityCookie,
  parseCookies,
  serializeCookie,
} from '@/modules/accounts/infrastructure/session-cookie';
import { SessionResolverImpl } from '@/modules/accounts/infrastructure/session-resolver';
import {
  ACCOUNT_CREATION_PARAMS,
  snapshotFromAccount,
  StripePayoutAdapter,
} from '@/modules/accounts/infrastructure/stripe-payout-adapter';
import { SupabaseAuthAdapter } from '@/modules/accounts/infrastructure/supabase-auth-adapter';
import { SupabasePhotoStorage } from '@/modules/listings/infrastructure/supabase-photo-storage';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { ErrorHandler } from '@/modules/platform/application/error-handler';
import type { SessionResolver } from '@/modules/platform/application/ports';
import { ResilientHttpClient } from '@/modules/platform/infrastructure/http-client';
import { createResilientFetch } from '@/modules/platform/infrastructure/resilient-fetch';
import { createPipeline } from '@/modules/platform/infrastructure/request-pipeline';
import { FakeClock } from '@tests/support/generators';
import { MemoryAuditStore, MemoryLogger } from '@tests/support/fakes';

const SECRET = 'cookie-secret-0123456789-0123456789-abc';
const email = (t: string) => unwrap(Email.parse(t));

// ---------------------------------------------------------------------------------------------
describe('Cookies de sesion', () => {
  const times = { createdAt: instantOf(1_000), lastActivityAt: instantOf(5_000) };

  it('la cookie de actividad firmada se decodifica; manipularla o cambiar el secreto la invalida', () => {
    const value = encodeActivityCookie(times, SECRET);
    expect(decodeActivityCookie(value, SECRET)).toEqual(times);
    expect(decodeActivityCookie(value, `${SECRET}x`)).toBeNull();
    const [payload, sig] = value.split('.');
    const forged = Buffer.from(JSON.stringify({ c: 1, a: 99_999_999_999_999 })).toString(
      'base64url',
    );
    expect(decodeActivityCookie(`${forged}.${sig}`, SECRET)).toBeNull();
    expect(decodeActivityCookie(`${payload}.deadbeef`, SECRET)).toBeNull();
  });

  it('valores ausentes, vacios o mal formados dan null sin lanzar', () => {
    for (const bad of [undefined, '', 'sin-punto', '.', 'a.b', '!!!.???']) {
      expect(decodeActivityCookie(bad, SECRET)).toBeNull();
    }
  });

  it('parseCookies lee pares nombre=valor y se queda con el primero repetido', () => {
    expect(parseCookies('a=1; b=2;c=3; a=9')).toEqual({ a: '1', b: '2', c: '3' });
    expect(parseCookies(null)).toEqual({});
  });

  it('los atributos son HttpOnly, SameSite=Lax y Secure (BR2-AC8)', () => {
    const c = serializeCookie('x', 'v', { maxAgeSeconds: 60, secure: true });
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Secure');
    expect(c).toContain('Path=/');
    expect(serializeCookie('x', 'v', { maxAgeSeconds: 60, secure: false })).not.toContain('Secure');
  });

  it('abre y cierra sesion con las tres cookies', () => {
    const opened = buildSessionCookies(
      { accessToken: 'AT', refreshToken: 'RT' },
      instantOf(10),
      SECRET,
      true,
    );
    expect(opened.map((c) => c.split('=')[0])).toEqual([
      COOKIE_ACCESS,
      COOKIE_REFRESH,
      COOKIE_ACTIVITY,
    ]);
    const cleared = clearSessionCookies(true);
    expect(cleared).toHaveLength(3);
    expect(cleared.every((c) => c.includes('Max-Age=0'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('SessionResolverImpl (P2-SES-1)', () => {
  const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

  const build = (auth: Partial<AuthPort>) => {
    const clock = new FakeClock(NOW);
    const resolver = new SessionResolverImpl({
      auth: {
        verifyAccessToken: () => Promise.resolve(null),
        refresh: () => Promise.resolve(err(appError('unauthenticated'))),
        ...auth,
      } as AuthPort,
      cookieSecret: SECRET,
      clock,
      logger: new MemoryLogger(),
      secureCookies: true,
    });
    return { resolver, clock };
  };

  const headers = (cookies: Record<string, string>) =>
    new Headers({
      cookie: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    });

  const activity = (createdAgo: number, lastAgo: number) =>
    encodeActivityCookie(
      { createdAt: instantOf(NOW - createdAgo), lastActivityAt: instantOf(NOW - lastAgo) },
      SECRET,
    );

  const identity = { userId: 'u-1', email: email('ana@example.com') };

  it('sin cookies o con firma invalida no hay sesion', async () => {
    const { resolver } = build({ verifyAccessToken: () => Promise.resolve(identity) });
    expect(await resolver.resolve(new Headers())).toBeNull();
    expect(
      await resolver.resolve(headers({ [COOKIE_ACCESS]: 'AT', [COOKIE_ACTIVITY]: 'falsa.firma' })),
    ).toBeNull();
  });

  it('una sesion vigente resuelve al artista sin renovar nada si la actividad es reciente', async () => {
    const { resolver } = build({ verifyAccessToken: () => Promise.resolve(identity) });
    const s = await resolver.resolve(
      headers({ [COOKIE_ACCESS]: 'AT', [COOKIE_ACTIVITY]: activity(MS.hour, MS.minute) }),
    );
    expect(s).toMatchObject({ userId: 'u-1', role: 'artist' });
  });

  it('renueva la actividad si pasaron 5 minutos', async () => {
    const { resolver } = build({ verifyAccessToken: () => Promise.resolve(identity) });
    const s = await resolver.resolve(
      headers({ [COOKIE_ACCESS]: 'AT', [COOKIE_ACTIVITY]: activity(MS.hour, 10 * MS.minute) }),
    );
    expect(s?.setCookies).toHaveLength(1);
    expect(s?.setCookies?.[0]).toContain(`${COOKIE_ACTIVITY}=`);
  });

  it('7 dias de inactividad o 30 de antiguedad la invalidan', async () => {
    const { resolver } = build({ verifyAccessToken: () => Promise.resolve(identity) });
    const idle = await resolver.resolve(
      headers({ [COOKIE_ACCESS]: 'AT', [COOKIE_ACTIVITY]: activity(8 * MS.day, SESSION_IDLE_MS) }),
    );
    expect(idle).toBeNull();
    const old = await resolver.resolve(
      headers({ [COOKIE_ACCESS]: 'AT', [COOKIE_ACTIVITY]: activity(30 * MS.day, MS.minute) }),
    );
    expect(old).toBeNull();
  });

  it('con el token de acceso caducado usa el de refresco y devuelve las cookies nuevas', async () => {
    const refresh = vi.fn(() =>
      Promise.resolve(ok({ ...identity, accessToken: 'AT2', refreshToken: 'RT2' })),
    );
    const { resolver } = build({ refresh });
    const s = await resolver.resolve(
      headers({
        [COOKIE_ACCESS]: 'vencido',
        [COOKIE_REFRESH]: 'RT',
        [COOKIE_ACTIVITY]: activity(MS.hour, MS.minute),
      }),
    );
    expect(refresh).toHaveBeenCalledWith('RT');
    expect(s?.userId).toBe('u-1');
    expect(s?.setCookies?.some((c) => c.startsWith(`${COOKIE_ACCESS}=AT2`))).toBe(true);
    expect(s?.setCookies?.some((c) => c.startsWith(`${COOKIE_REFRESH}=RT2`))).toBe(true);
  });

  it('si el refresco falla o no hay refresco, no hay sesion; nunca lanza', async () => {
    const { resolver } = build({});
    const base = { [COOKIE_ACCESS]: 'vencido', [COOKIE_ACTIVITY]: activity(MS.hour, MS.minute) };
    expect(await resolver.resolve(headers({ ...base, [COOKIE_REFRESH]: 'RT' }))).toBeNull();
    expect(await resolver.resolve(headers(base))).toBeNull();

    const { resolver: exploding } = build({
      verifyAccessToken: () => Promise.reject(new Error('red')),
    });
    await expect(exploding.resolve(headers(base))).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('Pipeline: identidad interna y cookies (P2-SES-1)', () => {
  const build = (sessions: SessionResolver) => {
    const logger = new MemoryLogger();
    const audit = new AuditLog(new MemoryAuditStore(), logger, new FakeClock(0));
    return createPipeline({
      table: [{ pattern: '/artista', access: 'artist' }],
      sessions,
      limiter: { check: () => Promise.resolve(ok({ remaining: 1 })) },
      errors: new ErrorHandler(logger, audit),
      logger,
      isDev: false,
    });
  };
  const req = (headers: Record<string, string> = {}) =>
    new NextRequest('http://localhost:3000/artista', { headers });

  it('fija x-ml-artist-id desde la sesion, borra cabeceras x-ml-* del cliente y anade Set-Cookie', async () => {
    const pipeline = build({
      resolve: () =>
        Promise.resolve({
          userId: 'u-42',
          role: 'artist',
          setCookies: ['a=1; Path=/', 'b=2; Path=/'],
        }),
    });
    const res = await pipeline(req({ 'x-ml-artist-id': 'otro-artista', 'x-ml-evil': '1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-request-x-ml-artist-id')).toBe('u-42');
    const forwarded = res.headers.get('x-middleware-override-headers') ?? '';
    expect(forwarded).not.toContain('x-ml-evil');
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('un navegador sin sesion va a la entrada y la API recibe 401 en JSON', async () => {
    const pipeline = build({ resolve: () => Promise.resolve(null) });
    const html = await pipeline(req({ accept: 'text/html,application/xhtml+xml' }));
    expect(html.status).toBe(307);
    expect(html.headers.get('location')).toBe('http://localhost:3000/acceso?caducada=1');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');

    const api = await pipeline(req({ accept: 'application/json' }));
    expect(api.status).toBe(401);
  });

  it('sin sesion un x-ml-artist-id falsificado no sirve: 401', async () => {
    const pipeline = build({ resolve: () => Promise.resolve(null) });
    const res = await pipeline(req({ 'x-ml-artist-id': 'otro-artista' }));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
type Call = { url: string; method: string; headers: Headers; body: string };

/** Servidor falso: responde segun una funcion y registra las peticiones que reciben los SDK. */
const fakeServer = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];
  const fetchFn = vi.fn((url: string, init: RequestInit) => {
    const body =
      typeof init.body === 'string'
        ? init.body
        : init.body instanceof Uint8Array
          ? `bytes:${init.body.byteLength}`
          : '';
    const call: Call = {
      url,
      method: String(init.method),
      headers: new Headers(init.headers),
      body,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  });
  const clock = new FakeClock(0);
  const client = new ResilientHttpClient({
    clock,
    logger: new MemoryLogger(),
    fetch: fetchFn,
    sleep: () => Promise.resolve(),
  });
  return { calls, client, fetchFn };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
  });

describe('StripePayoutAdapter (Accounts v2; SDK + cliente resiliente inyectado)', () => {
  const adapter = (server: ReturnType<typeof fakeServer>, manualPayouts = false) =>
    new StripePayoutAdapter({
      secretKey: 'sk_test_0123456789abcdef',
      apiVersion: '2026-01-01',
      connectWebhookSecret: 'whsec_test_secret_0123456789',
      fetch: createResilientFetch(server.client, 'stripe', 'api'),
      now: () => 1_700_000_000_000,
      manualPayouts,
    });

  /** Forma real de `GET /v2/core/accounts/{id}` observada en el sandbox (campos usados). */
  const accountJson = (over: Record<string, unknown> = {}) => ({
    id: 'acct_123',
    object: 'v2.core.account',
    closed: false,
    configuration: {
      recipient: {
        applied: true,
        capabilities: {
          stripe_balance: {
            payouts: { status: 'active', status_details: [] },
            stripe_transfers: { status: 'active', status_details: [] },
          },
        },
      },
    },
    requirements: { entries: [] },
    ...over,
  });

  const withCapabilities = (transfers: string, payouts: string) =>
    accountJson({
      configuration: {
        recipient: {
          applied: true,
          capabilities: {
            stripe_balance: {
              payouts: { status: payouts, status_details: [] },
              stripe_transfers: { status: transfers, status_details: [] },
            },
          },
        },
      },
    });

  const asAccount = (v: Record<string, unknown>) => v as unknown as Stripe.V2.Core.Account;

  it('crea la cuenta de Espana (recipient, panel Express, solo transferencias) con clave de idempotencia determinista', async () => {
    const server = fakeServer(() => json(accountJson()));
    const r = await adapter(server).createAccount({
      artistId: 'artist-1',
      email: email('ana@example.com'),
    });
    expect(unwrap(r).providerAccountId).toBe('acct_123');

    const call = server.calls[0] as Call;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.stripe.com/v2/core/accounts');
    expect(JSON.parse(call.body)).toEqual({
      ...ACCOUNT_CREATION_PARAMS,
      contact_email: 'ana@example.com',
      metadata: { artist_id: 'artist-1' },
    });
    // Con panel Express la plataforma asume comisiones y saldos negativos (exigido por Stripe).
    expect(ACCOUNT_CREATION_PARAMS.defaults.responsibilities).toEqual({
      fees_collector: 'application',
      losses_collector: 'application',
    });
    expect(call.headers.get('idempotency-key')).toBe('create_account_v2:artist-1');
    expect(call.headers.get('stripe-version')).toBe('2026-01-01');
    expect(server.calls).toHaveLength(1); // sin retirada manual no se toca el calendario
  });

  it('con retirada manual fija el calendario de pagos manual de la cuenta recien creada', async () => {
    const server = fakeServer((req) =>
      req.url.endsWith('/v1/balance_settings')
        ? json({ object: 'balance_settings' })
        : json(accountJson()),
    );
    const r = await adapter(server, true).createAccount({
      artistId: 'artist-1',
      email: email('ana@example.com'),
    });
    expect(unwrap(r).providerAccountId).toBe('acct_123');
    const second = server.calls[1] as Call;
    expect(second.url).toBe('https://api.stripe.com/v1/balance_settings');
    expect(second.headers.get('stripe-account')).toBe('acct_123');
    expect(new URLSearchParams(second.body).get('payments[payouts][schedule][interval]')).toBe(
      'manual',
    );
  });

  it('si el calendario manual falla, la creacion falla y el reintento reutiliza la misma cuenta', async () => {
    const server = fakeServer((req) =>
      req.url.endsWith('/v1/balance_settings')
        ? json({ error: { message: 'boom' } }, 500)
        : json(accountJson()),
    );
    const r = await adapter(server, true).createAccount({
      artistId: 'artist-1',
      email: email('ana@example.com'),
    });
    expect(!r.ok && r.error.code).toBe('dependency_unavailable');
    const creations = server.calls.filter((c) => c.url.endsWith('/v2/core/accounts'));
    expect(creations).toHaveLength(1);
    expect(creations[0]?.headers.get('idempotency-key')).toBe('create_account_v2:artist-1');
  });

  it('un 500 se reintenta porque la peticion lleva clave de idempotencia (la misma en ambos intentos)', async () => {
    let n = 0;
    const server = fakeServer(() =>
      ++n === 1 ? json({ error: { message: 'boom' } }, 500) : json(accountJson()),
    );
    const r = await adapter(server).createAccount({
      artistId: 'artist-1',
      email: email('ana@example.com'),
    });
    expect(r.ok).toBe(true);
    expect(server.calls).toHaveLength(2);
    expect(server.calls.map((c) => c.headers.get('idempotency-key'))).toEqual([
      'create_account_v2:artist-1',
      'create_account_v2:artist-1',
    ]);
  });

  it('el enlace de onboarding v2 devuelve la URL del proveedor', async () => {
    const server = fakeServer(() =>
      json({ object: 'v2.core.account_link', url: 'https://connect.stripe.com/setup/e/abc' }),
    );
    const r = await adapter(server).createOnboardingLink('acct_123', {
      returnUrl: 'https://app.test/artista/cobros',
      refreshUrl: 'https://app.test/artista/cobros',
    });
    expect(unwrap(r).url).toBe('https://connect.stripe.com/setup/e/abc');
    const call = server.calls[0] as Call;
    expect(call.url).toBe('https://api.stripe.com/v2/core/account_links');
    expect(JSON.parse(call.body)).toEqual({
      account: 'acct_123',
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          return_url: 'https://app.test/artista/cobros',
          refresh_url: 'https://app.test/artista/cobros',
        },
      },
    });
  });

  it('el SDK anade siempre una clave de idempotencia a los POST, asi que un fallo del servicio se reintenta con la misma clave', async () => {
    const failing = fakeServer(() => json({ error: { message: 'boom' } }, 503));
    const down = await adapter(failing).createOnboardingLink('acct_123', {
      returnUrl: 'x',
      refreshUrl: 'x',
    });
    expect(!down.ok && down.error.code).toBe('dependency_unavailable');
    expect(failing.calls).toHaveLength(3); // intento inicial + 2 reintentos acotados
    const keys = new Set(failing.calls.map((c) => c.headers.get('idempotency-key')));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBeTruthy();
  });

  it('lee el estado de la cuenta pidiendo capacidades y exigencias, y lo reduce al resumen del dominio', async () => {
    const server = fakeServer(() => json(accountJson()));
    const snapshot = unwrap(await adapter(server).getAccountSnapshot('acct_123'));
    expect(snapshot).toEqual({
      detailsSubmitted: true,
      transfersActive: true,
      payoutsEnabled: true,
      disabled: false,
      eventAt: 1_700_000_000_000,
    });
    const call = server.calls[0] as Call;
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/v2/core/accounts/acct_123');
    expect(url.searchParams.get('include[0]')).toBe('configuration.recipient');
    expect(url.searchParams.get('include[1]')).toBe('requirements');
  });

  it('snapshotFromAccount cubre cuentas incompletas, pendientes de verificacion, restringidas y cerradas', () => {
    // Recien creada: faltan datos del artista y las capacidades estan restringidas.
    const onboarding = snapshotFromAccount(
      asAccount({
        ...withCapabilities('restricted', 'restricted'),
        requirements: { entries: [{ awaiting_action_from: 'user' }] },
      }),
      1,
    );
    expect(onboarding).toMatchObject({
      detailsSubmitted: false,
      transfersActive: false,
      payoutsEnabled: false,
      disabled: false,
    });
    // Datos enviados, a la espera de Stripe.
    expect(
      snapshotFromAccount(
        asAccount({
          ...withCapabilities('pending', 'pending'),
          requirements: { entries: [{ awaiting_action_from: 'stripe' }] },
        }),
        1,
      ),
    ).toMatchObject({ detailsSubmitted: true, transfersActive: false, disabled: false });
    // Transferencias activas pero sin poder cobrar a su banco todavia.
    expect(
      snapshotFromAccount(asAccount(withCapabilities('active', 'restricted')), 1),
    ).toMatchObject({ transfersActive: true, payoutsEnabled: false });
    // Rechazada o cerrada: deshabilitada.
    expect(snapshotFromAccount(asAccount(withCapabilities('rejected', 'active')), 1).disabled).toBe(
      true,
    );
    expect(snapshotFromAccount(asAccount(accountJson({ closed: true })), 1).disabled).toBe(true);
    // Sin configuracion de recipient (cuenta de otra clase): nada activo.
    expect(snapshotFromAccount(asAccount({ id: 'a' }), 1)).toMatchObject({
      detailsSubmitted: true,
      transfersActive: false,
      payoutsEnabled: false,
      disabled: false,
    });
  });

  it('una peticion invalida es un error interno; no se confunde con una caida', async () => {
    const server = fakeServer(() =>
      json({ error: { type: 'invalid_request_error', message: 'No such account' } }, 400),
    );
    const r = await adapter(server).getAccountSnapshot('acct_nope');
    expect(!r.ok && r.error.code).toBe('internal');
  });

  it('el circuito abierto se traduce en dependency_unavailable sin llamar de nuevo', async () => {
    const server = fakeServer(() => json({ error: { message: 'boom' } }, 500));
    const a = adapter(server);
    for (let i = 0; i < 3; i++) await a.getAccountSnapshot('acct_1');
    expect(server.client.circuit('stripe').state()).toBe('open');
    const before = server.calls.length;
    const r = await a.getAccountSnapshot('acct_1');
    expect(!r.ok && r.error.code).toBe('dependency_unavailable');
    expect(server.calls.length).toBe(before);
  });

  describe('webhook de cuentas v2 (eventos finos): verificacion de firma con el SDK real', () => {
    const secret = 'whsec_test_secret_0123456789';
    const THIN = 'v2.core.account[requirements].updated';
    const ACCOUNT_REF = {
      id: 'acct_123',
      type: 'v2.core.account',
      url: '/v2/core/accounts/acct_123',
    };
    const event = (type: string = THIN, related: unknown = ACCOUNT_REF) => ({
      id: 'evt_1',
      object: 'v2.core.event',
      type,
      created: '2023-11-14T22:15:00.000Z',
      livemode: false,
      related_object: related,
    });
    const sign = (payload: string, s = secret) =>
      Stripe.webhooks.generateTestHeaderString({ payload, secret: s });

    it('acepta una firma valida y reduce el evento a la cuenta afectada', () => {
      const payload = JSON.stringify(event());
      const r = adapter(fakeServer(() => json({}))).parseEvent(payload, sign(payload));
      expect(unwrap(r)).toEqual({
        id: 'evt_1',
        type: THIN,
        providerAccountId: 'acct_123',
        occurredAt: Date.parse('2023-11-14T22:15:00.000Z'),
      });
    });

    it.each([
      'v2.core.account.updated',
      'v2.core.account.closed',
      'v2.core.account[configuration.recipient].capability_status_updated',
      'v2.core.account[configuration.recipient].updated',
      'v2.core.account[requirements].updated',
    ])('procesa el tipo %s', (type) => {
      const payload = JSON.stringify(event(type));
      const parsed = unwrap(adapter(fakeServer(() => json({}))).parseEvent(payload, sign(payload)));
      expect(parsed?.providerAccountId).toBe('acct_123');
    });

    it('rechaza firmas invalidas, secretos distintos y cuerpos manipulados', () => {
      const a = adapter(fakeServer(() => json({})));
      const payload = JSON.stringify(event());
      expect(a.parseEvent(payload, sign(payload, 'whsec_otro_secreto_0123456789')).ok).toBe(false);
      expect(a.parseEvent(payload, 't=1,v1=abc').ok).toBe(false);
      expect(a.parseEvent(payload, '').ok).toBe(false);
      expect(a.parseEvent(`${payload} `, sign(payload)).ok).toBe(false);
    });

    it('un tipo de evento que no usamos se confirma sin efecto', () => {
      for (const type of ['v2.core.account.person.created', 'v2.core.account_link.returned']) {
        const payload = JSON.stringify(event(type));
        const r = adapter(fakeServer(() => json({}))).parseEvent(payload, sign(payload));
        expect(unwrap(r)).toBeNull();
      }
    });

    it('un evento sin cuenta identificable se confirma sin efecto', () => {
      for (const related of [null, { id: 'cus_1', type: 'customer', url: '/x' }]) {
        const payload = JSON.stringify(event(THIN, related));
        const r = adapter(fakeServer(() => json({}))).parseEvent(payload, sign(payload));
        expect(unwrap(r)).toBeNull();
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('Adaptadores de Supabase (SDK + cliente resiliente inyectado)', () => {
  const URL = 'https://proyecto.supabase.co';

  const authAdapter = (server: ReturnType<typeof fakeServer>) =>
    new SupabaseAuthAdapter({
      url: URL,
      publishableKey: 'sb_publishable_publica_0123456789',
      serviceRoleKey: 'service-role-secreta-0123456789',
      fetch: createResilientFetch(server.client, 'supabase', 'auth'),
    });

  const userJson = {
    id: 'user-1',
    aud: 'authenticated',
    email: 'ana@example.com',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };
  const sessionJson = {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_in: 900,
    token_type: 'bearer',
    user: userJson,
  };

  it('pide el enlace con POST /auth/v1/otp, creando el usuario si no existe', async () => {
    const server = fakeServer(() => json({}));
    const r = await authAdapter(server).requestMagicLink(email('ana@example.com'));
    expect(r.ok).toBe(true);
    const call = server.calls[0] as Call;
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/auth/v1/otp');
    const body = JSON.parse(call.body) as { email: string; create_user: boolean };
    expect(body.email).toBe('ana@example.com');
    expect(body.create_user).toBe(true);
  });

  it('un fallo del proveedor al enviar es dependency_unavailable', async () => {
    const server = fakeServer(() => json({ msg: 'down' }, 503));
    const r = await authAdapter(server).requestMagicLink(email('ana@example.com'));
    expect(!r.ok && r.error.code).toBe('dependency_unavailable');
  });

  it('confirma el enlace con POST /auth/v1/verify (token_hash, tipo email) y devuelve la sesion', async () => {
    const server = fakeServer(() => json(sessionJson));
    const r = unwrap(await authAdapter(server).verifySignIn('hash-del-token'));
    expect(r).toEqual({
      userId: 'user-1',
      email: 'ana@example.com',
      accessToken: 'AT',
      refreshToken: 'RT',
    });
    const call = server.calls[0] as Call;
    expect(call.url).toContain('/auth/v1/verify');
    expect(JSON.parse(call.body)).toMatchObject({ token_hash: 'hash-del-token', type: 'email' });
  });

  it('un enlace invalido o usado es unauthenticated generico', async () => {
    const server = fakeServer(() =>
      json({ code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' }, 403),
    );
    const r = await authAdapter(server).verifySignIn('malo');
    expect(!r.ok && r.error.code).toBe('unauthenticated');
  });

  it('renueva con el token de refresco', async () => {
    const server = fakeServer(() => json(sessionJson));
    const r = unwrap(await authAdapter(server).refresh('RT-viejo'));
    expect(r.accessToken).toBe('AT');
    const call = server.calls[0] as Call;
    expect(call.url).toContain('/auth/v1/token');
    expect(call.url).toContain('grant_type=refresh_token');
    expect(JSON.parse(call.body)).toMatchObject({ refresh_token: 'RT-viejo' });
  });

  describe('verifyAccessToken', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = (claims: Record<string, unknown>) =>
      `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.c2lnbmF0dXJl`;
    const claims = {
      sub: 'user-1',
      email: 'ana@example.com',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 600,
      role: 'authenticated',
    };

    it('con un token valido devuelve la identidad', async () => {
      const server = fakeServer(() => json(userJson));
      const identity = await authAdapter(server).verifyAccessToken(jwt(claims));
      expect(identity).toEqual({ userId: 'user-1', email: 'ana@example.com' });
    });

    it('un token caducado, mal formado o rechazado por el servidor es null', async () => {
      const server = fakeServer(() => json({ msg: 'invalid' }, 401));
      const a = authAdapter(server);
      expect(await a.verifyAccessToken(jwt(claims))).toBeNull();
      expect(await a.verifyAccessToken(jwt({ ...claims, exp: 1 }))).toBeNull();
      expect(await a.verifyAccessToken('no-es-un-jwt')).toBeNull();
    });
  });

  describe('SupabasePhotoStorage', () => {
    const storage = (server: ReturnType<typeof fakeServer>) =>
      new SupabasePhotoStorage({
        url: URL,
        serviceRoleKey: 'service-role-secreta-0123456789',
        fetch: createResilientFetch(server.client, 'supabase', 'storage'),
      });

    it('sube bytes crudos al bucket privado con el tipo WebP y sin sobrescribir', async () => {
      const server = fakeServer(() => json({ Key: 'listing-images/a/b.webp', Id: 'id-1' }));
      const r = await storage(server).put(
        'artist-1/foto-1600.webp',
        new Uint8Array([1, 2, 3, 4]),
        'image/webp',
      );
      expect(r.ok).toBe(true);
      const call = server.calls[0] as Call;
      expect(call.method).toBe('POST');
      expect(call.url).toContain('/storage/v1/object/listing-images/artist-1/foto-1600.webp');
      expect(call.body).toBe('bytes:4');
      expect(call.headers.get('content-type')).toBe('image/webp');
      expect(call.headers.get('x-upsert')).toBe('false');
      // El token de servicio viaja, pero no queda en los logs del cliente resiliente.
      expect(call.headers.get('authorization')).toContain('Bearer ');
    });

    it('un fallo de Storage al subir es dependency_unavailable', async () => {
      const server = fakeServer(() => json({ message: 'down' }, 500));
      const r = await storage(server).put('k', new Uint8Array([1]), 'image/webp');
      expect(!r.ok && r.error.code).toBe('dependency_unavailable');
    });

    it('firma varias URL en una sola llamada y asocia cada una a su clave', async () => {
      const server = fakeServer((call) => {
        const { paths } = JSON.parse(call.body) as { paths: string[] };
        return json(
          paths.map((p) => ({
            path: p,
            signedURL: `/object/sign/listing-images/${p}?token=T`,
            error: null,
          })),
        );
      });
      const r = unwrap(await storage(server).signUrls(['a/1-480.webp', 'a/2-480.webp'], 3600));
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]?.url).toContain('/storage/v1/object/sign/listing-images');
      expect(JSON.parse((server.calls[0] as Call).body)).toMatchObject({ expiresIn: 3600 });
      expect(r.get('a/1-480.webp')).toBe(
        `${URL}/storage/v1/object/sign/listing-images/a/1-480.webp?token=T`,
      );
      expect(r.size).toBe(2);
    });

    it('borrar objetos usa el bucket correcto y una lista vacia no llama a nadie', async () => {
      const server = fakeServer(() => json([]));
      const s = storage(server);
      expect((await s.remove([])).ok).toBe(true);
      expect(server.calls).toHaveLength(0);
      expect((await s.remove(['a/1.webp', 'a/2.webp'])).ok).toBe(true);
      expect(server.calls[0]?.method).toBe('DELETE');
      expect(server.calls[0]?.url).toContain('/storage/v1/object/listing-images');
      expect(JSON.parse((server.calls[0] as Call).body)).toEqual({
        prefixes: ['a/1.webp', 'a/2.webp'],
      });
    });
  });
});
