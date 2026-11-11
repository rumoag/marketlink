import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { CircuitBreaker } from '@/modules/platform/domain/circuit-breaker';
import { REDACTED, redact } from '@/modules/platform/domain/redactor';
import { resolveRoute, ROUTE_TABLE } from '@/modules/platform/domain/route-table';
import { loadConfig, Secret } from '@/modules/platform/application/config';
import { AuditLog } from '@/modules/platform/application/audit-log';
import {
  ErrorHandler,
  normalizeError,
  toErrorResponse,
} from '@/modules/platform/application/error-handler';
import { LoggingOperatorNotifier } from '@/modules/platform/application/operator-notifier';
import { RATE_LIMIT_RULES, RateLimiter } from '@/modules/platform/application/rate-limiter';
import { noSessionResolver, type SessionResolver } from '@/modules/platform/application/ports';
import { ResilientHttpClient, safePath } from '@/modules/platform/infrastructure/http-client';
import { buildCsp, securityHeaders } from '@/modules/platform/infrastructure/security-headers';
import {
  clientIp,
  createPipeline,
  resolveCorrelationId,
} from '@/modules/platform/infrastructure/request-pipeline';
import { secretMatches } from '@/modules/platform/infrastructure/secrets';
import { createSubjectHasher } from '@/modules/platform/infrastructure/subject-hasher';
import { sslFor } from '@/modules/platform/infrastructure/db-client';
import { deepHealth, shallowHealth } from '@/modules/platform/infrastructure/health';
import { appError } from '@/modules/kernel/domain/app-error';
import { FakeClock } from '@tests/support/generators';
import { MemoryAuditStore, MemoryCounterStore, MemoryLogger } from '@tests/support/fakes';

const A32 = 'a'.repeat(32);
const B32 = 'b'.repeat(32);
const validEnv = {
  APP_ENV: 'sandbox',
  DATABASE_URL: 'postgres://u:p@h:6543/db',
  INTERNAL_JOBS_SECRET: A32,
  RATE_LIMIT_SALT: B32,
  SESSION_COOKIE_SECRET: 'c'.repeat(32),
  TRACKING_TOKEN_SECRET: 'd'.repeat(32),
  E2E_ENABLED: 'true',
};

describe('CircuitBreaker (ejemplos)', () => {
  it('cinco fallos consecutivos abren; a los 30 s pasa a half_open', () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    for (let i = 0; i < 5; i++) {
      expect(cb.tryAcquire()).toBe(true);
      cb.recordFailure();
    }
    expect(cb.state()).toBe('open');
    expect(cb.tryAcquire()).toBe(false);
    clock.advance(29_999);
    expect(cb.state()).toBe('open');
    clock.advance(1);
    expect(cb.state()).toBe('half_open');
  });

  it('half_open admite una sola prueba; el exito cierra y el fallo reabre 30 s', () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    for (let i = 0; i < 5; i++) {
      cb.tryAcquire();
      cb.recordFailure();
    }
    clock.advance(30_000);
    expect(cb.tryAcquire()).toBe(true);
    expect(cb.tryAcquire()).toBe(false);
    cb.recordFailure();
    expect(cb.state()).toBe('open');
    clock.advance(30_000);
    expect(cb.tryAcquire()).toBe(true);
    cb.recordSuccess();
    expect(cb.state()).toBe('closed');
  });

  it('abre por tasa del 50 % con al menos 10 llamadas en 60 s', () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    // Alterna exito y fallo: nunca hay 5 fallos seguidos.
    for (let i = 0; i < 10; i++) {
      cb.tryAcquire();
      if (i % 2 === 0) cb.recordSuccess();
      else cb.recordFailure();
      clock.advance(1_000);
    }
    expect(cb.state()).toBe('open');
  });
});

describe('Redactor (ejemplos)', () => {
  it('elimina claves sensibles y datos personales y enmascara texto', () => {
    const out = redact({
      Authorization: 'Bearer abc',
      user: { email: 'ana@example.com', phone: '+34612345678', name_public: 'Ana' },
      message: 'Escribe a ana@example.com con ES9121000418450200051332',
    }) as Record<string, unknown>;
    expect(out.Authorization).toBe(REDACTED);
    expect((out.user as Record<string, unknown>).email).toBe(REDACTED);
    expect((out.user as Record<string, unknown>).phone).toBe(REDACTED);
    expect(String(out.message)).not.toContain('example.com');
    expect(String(out.message)).not.toContain('ES91');
  });

  it('conserva los UUID (correlationId) y enmascara tokens largos que no lo son', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const out = redact({
      correlationId: uuid,
      note: `traza ${uuid}`,
      other: 'k'.repeat(40),
    }) as Record<string, string>;
    expect(out.correlationId).toBe(uuid);
    expect(out.note).toBe(`traza ${uuid}`);
    expect(out.other).toBe(REDACTED);
  });

  it('una clave __proto__ propia se conserva como dato y no altera el prototipo (regresion)', () => {
    const hostile = JSON.parse('{"__proto__": {"admin": true}, "a": 1}') as unknown;
    const out = redact(hostile) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__', 'a']);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(redact(redact(hostile))).toEqual(out);
  });

  it('maneja ciclos y errores sin lanzar', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect(JSON.stringify(redact(new Error('fallo con ana@example.com')))).not.toContain(
      'example.com',
    );
  });
});

describe('RouteTable', () => {
  it('coincidencia exacta, prefijo mas largo y denegar lo no registrado', () => {
    const table = [
      { pattern: '/a', access: 'public' as const },
      { pattern: '/a/*', access: 'artist' as const },
      { pattern: '/a/b/*', access: 'operator' as const },
    ];
    expect(resolveRoute(table, '/a')?.access).toBe('public');
    expect(resolveRoute(table, '/a/')?.access).toBe('public');
    expect(resolveRoute(table, '/a/x')?.access).toBe('artist');
    expect(resolveRoute(table, '/a/b/c')?.access).toBe('operator');
    expect(resolveRoute(table, '/b')).toBeUndefined();
    expect(resolveRoute(table, '/ab')).toBeUndefined();
  });

  it('la tabla de U1 marca explicitamente el acceso de cada ruta', () => {
    expect(resolveRoute(ROUTE_TABLE, '/')?.access).toBe('public');
    expect(resolveRoute(ROUTE_TABLE, '/api/health')?.access).toBe('public');
    expect(resolveRoute(ROUTE_TABLE, '/api/health/deep')?.access).toBe('internal');
    expect(resolveRoute(ROUTE_TABLE, '/api/internal/jobs/run')?.access).toBe('internal');
    expect(resolveRoute(ROUTE_TABLE, '/admin')).toBeUndefined();
  });
});

describe('Config (ejemplos)', () => {
  it('acepta una configuracion minima y aplica valores por defecto (BR-K4, BR-K5)', () => {
    const r = loadConfig(validEnv);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.appName).toBe('MarketLink');
      expect(r.value.flags).toEqual({ paymentManualEnabled: false, bizumEnabled: false });
      expect(r.value.maxListingPriceCents).toBe(100_000);
      expect(Object.isFrozen(r.value)).toBe(true);
      expect(r.value.databaseUrl).toBeInstanceOf(Secret);
    }
  });

  it('APP_ENV es obligatorio y solo admite sandbox o live (BR-K2)', () => {
    const { APP_ENV: _omit, ...sinEntorno } = validEnv;
    expect(loadConfig(sinEntorno).ok).toBe(false);
    expect(loadConfig({ ...validEnv, APP_ENV: 'produccion' }).ok).toBe(false);
  });

  it('live con sk_test se rechaza y el mensaje no incluye el valor (BR-K3, BR-K6)', () => {
    const r = loadConfig({
      ...validEnv,
      APP_ENV: 'live',
      STRIPE_SECRET_KEY: 'sk_test_ABCDEF1234567890',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain('ABCDEF1234567890');
  });

  it('los secretos cortos y las variables vacias se tratan como invalidas', () => {
    expect(loadConfig({ ...validEnv, INTERNAL_JOBS_SECRET: 'corto' }).ok).toBe(false);
    expect(loadConfig({ ...validEnv, DATABASE_URL: '' }).ok).toBe(false);
  });

  it('E2E_ENABLED se rechaza en live (SECURITY-09)', () => {
    const r = loadConfig({ ...validEnv, APP_ENV: 'live', APP_URL: 'https://x.es' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.join()).toContain('E2E_ENABLED');
  });

  it('sin modo de pruebas, los proveedores externos son obligatorios y se nombran sin valores', () => {
    const r = loadConfig({ ...validEnv, E2E_ENABLED: 'false' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issues = r.error.issues.join();
      for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY']) {
        expect(issues).toContain(name);
      }
    }
  });

  it('con todos los proveedores la configuracion se acepta y los secretos no se serializan', () => {
    const r = loadConfig({
      ...validEnv,
      E2E_ENABLED: 'false',
      SUPABASE_URL: 'https://proyecto.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_publica_0123456789',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-secreta-0123456789',
      STRIPE_SECRET_KEY: 'sk_test_ABCDEF1234567890',
      STRIPE_API_VERSION: '2026-01-01',
      STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_0123456789abcdef',
      STRIPE_PLATFORM_WEBHOOK_SECRET: 'whsec_platform0123456789',
      PACKLINK_API_KEY: 'packlink-key-0123456789',
      PACKLINK_WEBHOOK_SECRET: 'packlink-webhook-0123456789',
      RESEND_API_KEY: 're_test_0123456789',
      EMAIL_FROM: 'avisos@example.com',
      OPERATOR_EMAIL: 'operador@example.com',
      EMAIL_SANDBOX_REDIRECT: 'pruebas@example.com',
      PAYOUT_MODE: 'manual',
      CONTACT_EMAIL: 'contacto@example.com',
      OPERATOR_EMAILS: 'op@example.com',
      OPERATOR_TOTP_SECRETS: 'op@example.com:JBSWY3DPEHPK3PXP',
      OPERATOR_SESSION_SECRET: 's'.repeat(40),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const text = JSON.stringify(r.value);
      expect(text).not.toContain('service-role-secreta');
      expect(text).not.toContain('whsec_0123456789abcdef');
      expect(r.value.supabase?.url).toBe('https://proyecto.supabase.co');
    }
  });

  it('flags y nombre se leen del entorno', () => {
    const r = loadConfig({ ...validEnv, BIZUM_ENABLED: 'true', PRODUCT_NAME: 'ArtLink' });
    expect(r.ok && r.value.flags.bizumEnabled).toBe(true);
    expect(r.ok && r.value.appName).toBe('ArtLink');
  });
});

describe('Limitador de tasa (ejemplos)', () => {
  const make = () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 4, 10, 15, 0));
    const store = new MemoryCounterStore();
    const logger = new MemoryLogger();
    const auditStore = new MemoryAuditStore();
    const audit = new AuditLog(auditStore, logger, clock);
    const limiter = new RateLimiter({
      store,
      hasher: createSubjectHasher(B32),
      clock,
      audit,
      logger,
    });
    return { clock, store, logger, auditStore, limiter };
  };

  it('la peticion numero 6 de magic_link_email en una hora devuelve 429', async () => {
    const { limiter, auditStore } = make();
    for (let i = 1; i <= 5; i++) {
      expect(
        (
          await limiter.check('magic_link_email', 'ana@example.com', {
            failClosed: true,
            correlationId: 'c',
          })
        ).ok,
      ).toBe(true);
    }
    const sexta = await limiter.check('magic_link_email', 'ana@example.com', {
      failClosed: true,
      correlationId: 'c',
    });
    expect(sexta.ok).toBe(false);
    if (!sexta.ok) {
      expect(sexta.error.code).toBe('rate_limited');
      expect(sexta.error.retryAfterSeconds).toBe(2700); // 45 min hasta el final de la hora
    }
    expect(auditStore.events.map((e) => e.action)).toEqual(['rate_limited']);
    expect(RATE_LIMIT_RULES.magic_link_email.limit).toBe(5);
  });

  it('sujetos distintos tienen contadores independientes', async () => {
    const { limiter } = make();
    for (let i = 0; i < 5; i++)
      await limiter.check('magic_link_email', 'a@x.com', { failClosed: true, correlationId: 'c' });
    expect(
      (await limiter.check('magic_link_email', 'b@x.com', { failClosed: true, correlationId: 'c' }))
        .ok,
    ).toBe(true);
  });

  it('el sujeto se guarda como resumen y no en claro', async () => {
    const { limiter, store } = make();
    const spy = vi.spyOn(store, 'increment');
    await limiter.check('quote_ip', '203.0.113.7', { failClosed: false, correlationId: 'c' });
    const hash = spy.mock.calls[0]?.[1] ?? '';
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('203.0.113.7');
  });

  it('si el almacen falla: cerrado en autenticacion/pago y abierto en lectura publica (BR-L4)', async () => {
    const { limiter, store } = make();
    store.failWith = new Error('db caida');
    const cerrado = await limiter.check('checkout_ip', '1.1.1.1', {
      failClosed: true,
      correlationId: 'c',
    });
    expect(!cerrado.ok && cerrado.error.code).toBe('dependency_unavailable');
    const abierto = await limiter.check('tracking_ip', '1.1.1.1', {
      failClosed: false,
      correlationId: 'c',
    });
    expect(abierto.ok).toBe(true);
  });

  it('una regla desconocida es un error interno', async () => {
    const { limiter } = make();
    const r = await limiter.check('no_existe', 'x', { failClosed: true, correlationId: 'c' });
    expect(!r.ok && r.error.code).toBe('internal');
  });
});

describe('ErrorHandler y AuditLog', () => {
  const make = () => {
    const logger = new MemoryLogger();
    const store = new MemoryAuditStore();
    const audit = new AuditLog(store, logger, new FakeClock(0));
    return { logger, store, audit, handler: new ErrorHandler(logger, audit) };
  };

  it('unauthenticated y forbidden dejan AuditEvent (BR-G5)', async () => {
    const { handler, store } = make();
    expect(
      (await handler.handle(appError('unauthenticated'), { correlationId: 'c1', resource: '/x' }))
        .status,
    ).toBe(401);
    expect(
      (await handler.handle(appError('forbidden'), { correlationId: 'c2', actorId: 'u1' })).status,
    ).toBe(403);
    expect(store.events.map((e) => e.action)).toEqual(['auth_failure', 'authz_denied']);
  });

  it('una excepcion desconocida da 500 generico y se registra sin filtrar al cliente', async () => {
    const { handler, logger } = make();
    const res = await handler.handle(new Error('password=hunter2 en la consulta'), {
      correlationId: 'c3',
    });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true);
  });

  it('rate_limited incluye Retry-After; validation incluye solo campos', () => {
    const r = toErrorResponse(appError('rate_limited', { retryAfterSeconds: 12.2 }), 'c');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('13');
    const v = toErrorResponse(
      appError('validation', { details: [{ field: 'email', reason: 'invalido' }] }),
      'c',
    );
    expect(v.body.error.details).toEqual([{ field: 'email', reason: 'invalido' }]);
    expect(normalizeError('texto').code).toBe('internal');
  });

  it('AuditLog deja copia en el log, redacta detalles y no lanza si el almacen falla', async () => {
    const { audit, store, logger } = make();
    store.failWith = new Error('db caida');
    await expect(
      audit.record({
        actorType: 'anonymous',
        action: 'webhook_signature_invalid',
        outcome: 'denied',
        correlationId: 'c',
        details: { email: 'ana@example.com' },
      }),
    ).resolves.toBeUndefined();
    expect(logger.entries.some((e) => e.message === 'audit_event' && e.fields.audit === true)).toBe(
      true,
    );
    expect(logger.entries.some((e) => e.message === 'audit_store_failed')).toBe(true);
  });

  it('el notificador solo registra en U1', async () => {
    const logger = new MemoryLogger();
    await new LoggingOperatorNotifier(logger).notify({
      severity: 'critical',
      title: 'trabajo fallido',
    });
    await new LoggingOperatorNotifier(logger).notify({ severity: 'warning', title: 'aviso' });
    expect(logger.entries.map((e) => e.level)).toEqual(['error', 'warn']);
  });
});

describe('ResilientHttpClient (ejemplos)', () => {
  const setup = (responses: Array<Response | Error>) => {
    const clock = new FakeClock(0);
    const logger = new MemoryLogger();
    const waits: number[] = [];
    let call = 0;
    const fetchFn = vi.fn((_url: string, _init: RequestInit) => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      clock.advance(10);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as Response);
    });
    const client = new ResilientHttpClient({
      clock,
      logger,
      fetch: fetchFn,
      sleep: (ms) => {
        waits.push(ms);
        clock.advance(ms);
        return Promise.resolve();
      },
    });
    return { client, fetchFn, logger, waits, clock };
  };

  const get = {
    provider: 'packlink',
    operation: 'quote',
    method: 'GET',
    url: 'https://api.test/v1/x?secret=1',
  } as const;

  it('devuelve Ok en 2xx y registra sin parametros ni cuerpos', async () => {
    const { client, logger } = setup([new Response('{"a":1}', { status: 200 })]);
    const r = await client.request({ ...get, correlationId: 'c' });
    expect(r.ok && r.value.status).toBe(200);
    const entry = logger.entries.find((e) => e.message === 'http_call');
    expect(entry?.fields.path).toBe('/v1/x');
    expect(JSON.stringify(entry)).not.toContain('secret=1');
  });

  it('reintenta GET ante 503 con esperas de 200 ms y 800 ms', async () => {
    const { client, waits, fetchFn } = setup([
      new Response('', { status: 503 }),
      new Response('', { status: 503 }),
      new Response('ok', { status: 200 }),
    ]);
    const r = await client.request(get);
    expect(r.ok).toBe(true);
    expect(waits).toEqual([200, 800]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('no reintenta POST sin clave de idempotencia, pero si con ella', async () => {
    const sin = setup([new Response('', { status: 500 })]);
    const r1 = await sin.client.request({ ...get, method: 'POST', body: '{}' });
    expect(r1.ok).toBe(false);
    expect(sin.fetchFn).toHaveBeenCalledTimes(1);

    const con = setup([new Response('', { status: 500 }), new Response('', { status: 201 })]);
    const r2 = await con.client.request({
      ...get,
      method: 'POST',
      body: '{}',
      idempotencyKey: 'k1',
    });
    expect(r2.ok).toBe(true);
    expect(con.fetchFn).toHaveBeenCalledTimes(2);
    const headers = con.fetchFn.mock.calls[0]?.[1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('k1');
  });

  it('un 4xx no cuenta como fallo ni se reintenta', async () => {
    const { client, fetchFn } = setup([new Response('no', { status: 404 })]);
    const r = await client.request(get);
    expect(r.ok && r.value.status).toBe(404);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('respeta Retry-After de hasta 5 s y no reintenta si es mayor (BR-H3)', async () => {
    const corto = setup([
      new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      new Response('', { status: 200 }),
    ]);
    expect((await corto.client.request(get)).ok).toBe(true);
    expect(corto.waits).toEqual([2000]);

    const largo = setup([new Response('', { status: 429, headers: { 'retry-after': '60' } })]);
    const r = await largo.client.request(get);
    expect(!r.ok && r.error.code).toBe('dependency_unavailable');
    expect(largo.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('tras cinco fallos el circuito rechaza sin llamar y es independiente por proveedor', async () => {
    const { client, fetchFn } = setup([new TypeError('fetch failed')]);
    for (let i = 0; i < 2; i++) await client.request(get); // 3 intentos cada uno = 6 llamadas, abre a la 5.
    expect(client.circuit('packlink').state()).toBe('open');
    const calls = fetchFn.mock.calls.length;
    const r = await client.request(get);
    expect(!r.ok && r.error.code).toBe('dependency_unavailable');
    expect(fetchFn.mock.calls.length).toBe(calls); // sin llamada nueva
    expect(client.circuit('stripe').state()).toBe('closed');
  });

  it('un tiempo de espera cuenta como fallo', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const { client, logger } = setup([timeout]);
    const r = await client.request({ ...get, method: 'POST' });
    expect(r.ok).toBe(false);
    expect(logger.entries.find((e) => e.message === 'http_call')?.fields.outcome).toBe('timeout');
  });

  it('safePath quita consulta y fragmento', () => {
    expect(safePath('https://a.b/c/d?x=1#f')).toBe('/c/d');
    expect(safePath('no es url')).toBe('(invalida)');
  });
});

describe('Cabeceras de seguridad (BR-S1 a BR-S3)', () => {
  const nonce = 'abc123==';

  it('incluye todas las cabeceras exigidas', () => {
    const h = securityHeaders({ nonce });
    expect(h['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Content-Security-Policy']).toBeTruthy();
  });

  it('la CSP parte de default-src self, usa nonce y no tiene unsafe-inline ni unsafe-eval', () => {
    const csp = buildCsp({ nonce, imgSources: ['https://*.supabase.co'] });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('https://*.supabase.co');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it("en desarrollo anade 'unsafe-eval' solo a script-src", () => {
    const csp = buildCsp({ nonce, isDev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain('unsafe-inline');
  });
});

describe('RequestPipeline', () => {
  const build = (
    opts: {
      sessions?: SessionResolver;
      operatorSessions?: SessionResolver;
      limitResult?: 'ok' | 'limited' | 'unavailable';
    } = {},
  ) => {
    const logger = new MemoryLogger();
    const store = new MemoryAuditStore();
    const audit = new AuditLog(store, logger, new FakeClock(0));
    const check = vi.fn(() => {
      if (opts.limitResult === 'limited') {
        return Promise.resolve({
          ok: false as const,
          error: appError('rate_limited', { retryAfterSeconds: 30 }),
        });
      }
      if (opts.limitResult === 'unavailable') {
        return Promise.resolve({ ok: false as const, error: appError('dependency_unavailable') });
      }
      return Promise.resolve({ ok: true as const, value: { remaining: 1 } });
    });
    const table = [
      { pattern: '/', access: 'public' as const },
      {
        pattern: '/limitada',
        access: 'public' as const,
        rateLimit: 'checkout_ip' as const,
        failClosed: true,
      },
      { pattern: '/artista', access: 'artist' as const },
      { pattern: '/operador', access: 'operator' as const },
    ];
    const pipeline = createPipeline({
      table,
      sessions: opts.sessions ?? noSessionResolver,
      operatorSessions: opts.operatorSessions,
      limiter: { check },
      errors: new ErrorHandler(logger, audit),
      logger,
      isDev: false,
      newNonce: () => 'nonce-fijo',
    });
    return { pipeline, check, store };
  };
  const req = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost:3000${path}`, { headers });

  it('una ruta publica pasa con cabeceras de seguridad, nonce y correlacion', async () => {
    const { pipeline } = build();
    const res = await pipeline(req('/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("'nonce-nonce-fijo'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('una ruta no registrada se deniega con 404 generico y cabeceras', async () => {
    const { pipeline } = build();
    const res = await pipeline(req('/oculta'));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(JSON.stringify(await res.json())).not.toContain('oculta');
  });

  it('acepta un x-correlation-id UUID y descarta cualquier otro', async () => {
    const { pipeline } = build();
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    expect(
      (await pipeline(req('/', { 'x-correlation-id': uuid }))).headers.get('x-correlation-id'),
    ).toBe(uuid);
    const otro = await pipeline(req('/', { 'x-correlation-id': '<script>alert(1)</script>' }));
    expect(otro.headers.get('x-correlation-id')).not.toContain('script');
    expect(otro.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rutas de artista y operador exigen sesion y rol', async () => {
    const sinSesion = build();
    expect((await sinSesion.pipeline(req('/artista'))).status).toBe(401);
    expect(sinSesion.store.events[0]?.action).toBe('auth_failure');

    const artista = build({
      sessions: { resolve: () => Promise.resolve({ userId: 'u1', role: 'artist' }) },
    });
    expect((await artista.pipeline(req('/artista'))).status).toBe(200);
    // Sin servicio de operador configurado, el panel no existe.
    expect((await artista.pipeline(req('/operador'))).status).toBe(404);

    // Con la sesion de operador (cookie propia): la de artista no vale y sin cookie es 401.
    const sinOperador = build({
      sessions: { resolve: () => Promise.resolve({ userId: 'u1', role: 'artist' }) },
      operatorSessions: noSessionResolver,
    });
    expect((await sinOperador.pipeline(req('/operador'))).status).toBe(401);
    const operador = build({
      operatorSessions: {
        resolve: () => Promise.resolve({ userId: 'op@example.com', role: 'operator' }),
      },
    });
    const ok = await operador.pipeline(req('/operador'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('referrer-policy')).toBe('same-origin');
    const equivocado = build({
      operatorSessions: { resolve: () => Promise.resolve({ userId: 'u1', role: 'artist' }) },
    });
    expect((await equivocado.pipeline(req('/operador'))).status).toBe(403);
    expect(equivocado.store.events.at(-1)?.action).toBe('authz_denied');
  });

  it('limite de tasa excedido da 429 con Retry-After; almacen caido en ruta cerrada da 503', async () => {
    const limited = build({ limitResult: 'limited' });
    const r429 = await limited.pipeline(
      req('/limitada', { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }),
    );
    expect(r429.status).toBe(429);
    expect(r429.headers.get('retry-after')).toBe('30');
    expect(limited.check).toHaveBeenCalledWith(
      'checkout_ip',
      '203.0.113.9',
      expect.objectContaining({ failClosed: true }),
    );

    const unavailable = build({ limitResult: 'unavailable' });
    expect((await unavailable.pipeline(req('/limitada'))).status).toBe(503);
  });

  it('una excepcion interna falla cerrado con 500 generico', async () => {
    const boom: SessionResolver = { resolve: () => Promise.reject(new Error('detalle interno')) };
    const { pipeline } = build({ sessions: boom });
    const res = await pipeline(req('/artista'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('detalle interno');
  });

  it('clientIp usa el primer elemento de x-forwarded-for', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8' }))).toBe('1.2.3.4');
    expect(clientIp(new Headers({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('Secretos y salud', () => {
  it('secretMatches compara en tiempo constante y rechaza vacios o longitudes distintas', () => {
    const s = new Secret(A32);
    expect(secretMatches(A32, s)).toBe(true);
    expect(secretMatches(`${A32}x`, s)).toBe(false);
    expect(secretMatches('', s)).toBe(false);
    expect(secretMatches(null, s)).toBe(false);
    expect(secretMatches(A32, undefined)).toBe(false);
  });

  it('salud superficial minima y profunda con base disponible o caida', async () => {
    expect(shallowHealth()).toEqual({ status: 'ok' });
    expect(await deepHealth({ query: () => Promise.resolve({ rows: [] } as never) })).toEqual({
      status: 'ok',
      checks: { database: 'ok' },
    });
    expect(await deepHealth({ query: () => Promise.reject(new Error('x')) })).toEqual({
      status: 'degraded',
      checks: { database: 'fail' },
    });
  });

  it('la salud profunda se degrada si un trabajo listo lleva esperando mas de 5 minutos', async () => {
    const dbWith = (seconds: string | null) => ({
      query: (sql: string) =>
        Promise.resolve({
          rows: sql.includes('FROM jobs') ? [{ s: seconds }] : [{ n: '0' }],
        } as never),
    });
    const ok = await deepHealth(dbWith('120'));
    expect(ok.status).toBe('ok');
    expect(ok.jobsOldestPendingSeconds).toBe(120);
    const stuck = await deepHealth(dbWith('600'));
    expect(stuck.status).toBe('degraded');
    expect(stuck.jobsOldestPendingSeconds).toBe(600);
    // Sin trabajos listos no hay dato y la salud sigue en orden.
    const none = await deepHealth(dbWith(null));
    expect(none.status).toBe('ok');
    expect(none.jobsOldestPendingSeconds).toBeUndefined();
  });

  it('la salud profunda entrega la causa del fallo de la base para dejarla en los registros', async () => {
    const causes: unknown[] = [];
    const cause = new Error('password authentication failed');
    const result = await deepHealth({ query: () => Promise.reject(cause) }, (c) => causes.push(c));
    expect(result.checks.database).toBe('fail');
    expect(causes).toEqual([cause]);
    // Con la base disponible no se llama.
    await deepHealth({ query: () => Promise.resolve({ rows: [] } as never) }, (c) =>
      causes.push(c),
    );
    expect(causes).toHaveLength(1);
  });
});

describe('TLS hacia la base de datos y cadena de conexion', () => {
  it('sin TLS en servidores locales y con TLS fuera de ellos', () => {
    for (const host of ['localhost', '127.0.0.1', 'postgres', 'db']) {
      expect(sslFor(`postgresql://u:p@${host}:5432/x`)).toBe(false);
    }
    expect(sslFor('postgresql://u:p@aws-1-eu-west-3.pooler.supabase.com:6543/postgres')).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('con el certificado de la CA verifica al servidor', () => {
    expect(sslFor('postgresql://u:p@host.example.com:6543/x', 'PEM')).toEqual({
      ca: 'PEM',
      rejectUnauthorized: true,
    });
  });

  it('una cadena que no es una URL devuelve sin TLS en lugar de fallar', () => {
    expect(sslFor('no es una url')).toBe(false);
  });

  const env = (over: Record<string, string>) =>
    ({
      APP_ENV: 'sandbox',
      DATABASE_URL:
        'postgresql://marketlink_app.p:Abc123@aws-1-eu-west-3.pooler.supabase.com:6543/postgres',
      INTERNAL_JOBS_SECRET: 'a'.repeat(32),
      RATE_LIMIT_SALT: 'b'.repeat(32),
      SESSION_COOKIE_SECRET: 'c'.repeat(32),
      TRACKING_TOKEN_SECRET: 'd'.repeat(32),
      E2E_ENABLED: 'true',
      ...over,
    }) as unknown as NodeJS.ProcessEnv;

  it.each([
    ['con comillas', '"postgresql://u:p@h:6543/postgres"'],
    ['con espacio inicial', ' postgresql://u:p@h:6543/postgres'],
    ['sin esquema', 'u:p@h:6543/postgres'],
    ['con el nombre de la variable', 'DATABASE_URL=postgresql://u:p@h:6543/postgres'],
  ])('rechaza una DATABASE_URL %s (pg la leeria con un servidor falso)', (_name, url) => {
    expect(loadConfig(env({ DATABASE_URL: url })).ok).toBe(false);
  });

  it('acepta postgres:// y postgresql://', () => {
    expect(loadConfig(env({ DATABASE_URL: 'postgres://u:p@h:6543/postgres' })).ok).toBe(true);
    expect(loadConfig(env({})).ok).toBe(true);
  });

  it('el certificado de la base admite saltos de linea escapados', () => {
    const pem = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(60)}\n-----END CERTIFICATE-----`;
    const r = loadConfig(env({ DATABASE_CA_CERT: pem }));
    expect(r.ok && r.value.databaseCaCert?.includes('\n')).toBe(true);
    expect(r.ok && r.value.databaseCaCert?.includes('\\n')).toBe(false);
  });
});
