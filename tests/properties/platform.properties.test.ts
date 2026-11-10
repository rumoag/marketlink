import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { redact, REDACTED, isSensitiveKey } from '@/modules/platform/domain/redactor';
import { CircuitBreaker, DEFAULT_CIRCUIT_CONFIG } from '@/modules/platform/domain/circuit-breaker';
import { RateLimiter, type RateLimitRule } from '@/modules/platform/application/rate-limiter';
import { AuditLog } from '@/modules/platform/application/audit-log';
import { ErrorHandler } from '@/modules/platform/application/error-handler';
import { loadConfig } from '@/modules/platform/application/config';
import {
  ALLOWED_HTTP_STATUSES,
  ERROR_CODES,
  type AppError,
} from '@/modules/kernel/domain/app-error';
import { FakeClock } from '@tests/support/generators';
import { MemoryAuditStore, MemoryCounterStore, MemoryLogger } from '@tests/support/fakes';

// ---------------------------------------------------------------------------------------------
// P-U1-15 Redaccion de logs
// ---------------------------------------------------------------------------------------------
const tokenArb = fc.stringMatching(/^[A-Za-z0-9]{40}$/);
const emailArb = fc
  .tuple(fc.stringMatching(/^[a-z]{3,8}$/), fc.stringMatching(/^[a-z]{3,8}$/))
  .map(([l, d]) => `${l}@${d}.com`);

const sameShape = (original: unknown, redacted: unknown): boolean => {
  if (Array.isArray(original)) {
    return (
      Array.isArray(redacted) &&
      redacted.length === original.length &&
      original.every((item, i) => sameShape(item, redacted[i]))
    );
  }
  if (original !== null && typeof original === 'object') {
    if (redacted === null || typeof redacted !== 'object' || Array.isArray(redacted)) return false;
    const o = original as Record<string, unknown>;
    const r = redacted as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length !== Object.keys(r).length) return false;
    return keys.every((k) => (isSensitiveKey(k) ? r[k] === REDACTED : sameShape(o[k], r[k])));
  }
  return typeof original === typeof redacted;
};

describe('P-U1-15 redaccion de logs', () => {
  it('es idempotente: redact(redact(x)) = redact(x)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (x) => {
        const once = redact(x);
        expect(redact(once)).toEqual(once);
      }),
    );
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        expect(redact(redact(s))).toEqual(redact(s));
      }),
    );
  });

  it('no deja ningun secreto generado en la salida', () => {
    fc.assert(
      fc.property(tokenArb, tokenArb, tokenArb, emailArb, (t1, t2, t3, mail) => {
        const input = {
          authorization: `Bearer ${t1}`,
          nested: { password: t2, deeper: [{ api_key: t3 }] },
          note: `contacta con ${mail} o usa ${t1}`,
          list: [`token en texto ${t2}`],
        };
        const out = JSON.stringify(redact(input));
        for (const secret of [t1, t2, t3, mail]) expect(out).not.toContain(secret);
      }),
    );
  });

  it('conserva la forma estructural y no modifica el original', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (x) => {
        const snapshot = structuredClone(x);
        const out = redact(x);
        expect(x).toEqual(snapshot);
        expect(sameShape(x, out)).toBe(true);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// P-U1-13 Interruptor de circuito contra un modelo de referencia
// ---------------------------------------------------------------------------------------------
type Op =
  { kind: 'acquire' } | { kind: 'success' } | { kind: 'failure' } | { kind: 'advance'; ms: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Op>({ kind: 'acquire' }) },
  { weight: 3, arbitrary: fc.constant<Op>({ kind: 'success' }) },
  { weight: 5, arbitrary: fc.constant<Op>({ kind: 'failure' }) },
  {
    weight: 3,
    arbitrary: fc.integer({ min: 0, max: 40_000 }).map((ms): Op => ({ kind: 'advance', ms })),
  },
);

/** Modelo de referencia: reglas BR-C1 a BR-C7 escritas de forma directa. */
class CircuitModel {
  state: 'closed' | 'open' | 'half_open' = 'closed';
  consecutive = 0;
  window: { t: number; failed: boolean }[] = [];
  openedAt = 0;
  probe = false;

  private tick(now: number): void {
    if (this.state === 'open' && now - this.openedAt >= 30_000) {
      this.state = 'half_open';
      this.probe = false;
    }
  }
  current(now: number): string {
    this.tick(now);
    return this.state;
  }
  acquire(now: number): boolean {
    this.tick(now);
    if (this.state === 'closed') return true;
    if (this.state === 'open') return false;
    if (this.probe) return false;
    this.probe = true;
    return true;
  }
  result(now: number, failed: boolean): void {
    this.tick(now);
    if (this.state === 'half_open') {
      if (failed) {
        this.state = 'open';
        this.openedAt = now;
      } else {
        this.state = 'closed';
        this.consecutive = 0;
        this.window = [];
      }
      this.probe = false;
      return;
    }
    if (this.state !== 'closed') return;
    this.consecutive = failed ? this.consecutive + 1 : 0;
    this.window = [...this.window, { t: now, failed }].filter((s) => s.t > now - 60_000);
    const rate = this.window.filter((s) => s.failed).length / this.window.length;
    if (this.consecutive >= 5 || (this.window.length >= 10 && rate >= 0.5)) {
      this.state = 'open';
      this.openedAt = now;
      this.probe = false;
    }
  }
}

describe('P-U1-13 interruptor de circuito', () => {
  it('coincide con el modelo y respeta los invariantes de cada estado', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 80 }), (ops) => {
        const clock = new FakeClock(1_000_000);
        const sut = new CircuitBreaker(clock, DEFAULT_CIRCUIT_CONFIG);
        const model = new CircuitModel();
        let pending = 0;
        let probesInFlight = 0;

        for (const op of ops) {
          const now = clock.now();
          if (op.kind === 'advance') {
            clock.advance(op.ms);
          } else if (op.kind === 'acquire') {
            const before = sut.state();
            const got = sut.tryAcquire();
            expect(got).toBe(model.acquire(now));
            if (before === 'open') expect(got).toBe(false); // en open no se permite ninguna llamada
            if (got) {
              pending += 1;
              if (before === 'half_open') probesInFlight += 1;
            }
            expect(probesInFlight).toBeLessThanOrEqual(1); // en half_open, como maximo una
          } else if (pending > 0) {
            pending -= 1;
            const failed = op.kind === 'failure';
            if (failed) sut.recordFailure();
            else sut.recordSuccess();
            model.result(now, failed);
            probesInFlight = 0;
          }
          expect(sut.state()).toBe(model.current(clock.now()));
        }
      }),
    );
  });

  it('un exito en closed reinicia los fallos consecutivos', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 }), (n) => {
        const clock = new FakeClock(0);
        const cb = new CircuitBreaker(clock);
        for (let i = 0; i < n; i++) {
          cb.tryAcquire();
          cb.recordFailure();
        }
        cb.tryAcquire();
        cb.recordSuccess();
        for (let i = 0; i < 4; i++) {
          cb.tryAcquire();
          cb.recordFailure();
        }
        expect(cb.state()).toBe('closed'); // 4 fallos tras el reinicio no abren
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// P-U1-14 Limitador de tasa contra un modelo de referencia
// ---------------------------------------------------------------------------------------------
describe('P-U1-14 limitador de tasa', () => {
  const rules: Record<string, RateLimitRule> = { test_rule: { limit: 3, windowSeconds: 10 } };

  it('permite min(n, limit) por ventana, reinicia al cambiar de ventana y Retry-After esta en (0, W]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 12_000 }), { minLength: 1, maxLength: 40 }),
        async (gaps) => {
          const clock = new FakeClock(5_000_000);
          const store = new MemoryCounterStore();
          const logger = new MemoryLogger();
          const audit = new AuditLog(new MemoryAuditStore(), logger, clock);
          const limiter = new RateLimiter({
            store,
            hasher: (_r, s) => s,
            clock,
            audit,
            logger,
            rules,
          });
          const perWindow = new Map<number, number>();

          for (const gap of gaps) {
            clock.advance(gap);
            const nowMs = clock.now();
            const windowIndex = Math.floor(Math.floor(nowMs / 1000) / 10);
            const k = (perWindow.get(windowIndex) ?? 0) + 1;
            perWindow.set(windowIndex, k);

            const res = await limiter.check('test_rule', 'sujeto', {
              failClosed: true,
              correlationId: 'c',
            });
            expect(res.ok).toBe(k <= 3);
            if (!res.ok) {
              expect(res.error.code).toBe('rate_limited');
              const retry = res.error.retryAfterSeconds ?? 0;
              expect(retry).toBeGreaterThan(0);
              expect(retry).toBeLessThanOrEqual(10);
            }
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// P-U1-16 Mapeo de errores a HTTP
// ---------------------------------------------------------------------------------------------
describe('P-U1-16 mapeo de errores a HTTP', () => {
  const marker = 'INTERNO_SELECT_FROM_users_en_/srv/app.ts';

  it('el estado pertenece al conjunto permitido y el cuerpo no filtra mensajes internos', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ERROR_CODES),
        fc.boolean(),
        fc.string(),
        async (code, asAppError, noise) => {
          const logger = new MemoryLogger();
          const audit = new AuditLog(new MemoryAuditStore(), logger, new FakeClock(0));
          const handler = new ErrorHandler(logger, audit);
          const cause: unknown = asAppError
            ? ({ code, message: `${marker}${noise}`, retryable: false } satisfies AppError)
            : new Error(`${marker}${noise}`);
          const res = await handler.handle(cause, { correlationId: 'corr-1' });
          expect(ALLOWED_HTTP_STATUSES).toContain(res.status);
          const body = JSON.stringify(res.body);
          expect(body).not.toContain(marker);
          expect(body).not.toMatch(/\bat .*\(|stack/i);
          expect(res.body.error.correlationId).toBe('corr-1');
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// P-U1-17 Carga de configuracion
// ---------------------------------------------------------------------------------------------
describe('P-U1-17 carga de configuracion', () => {
  const secretArb = fc.stringMatching(/^[A-Za-z0-9]{32,48}$/);
  const keySuffix = fc.stringMatching(/^[A-Za-z0-9]{24,32}$/);

  const baseEnv = (a: string, b: string, c: string, dbPw: string) => ({
    DATABASE_URL: `postgres://user:${dbPw}@host:6543/db`,
    DATABASE_CA_CERT: `-----BEGIN CERTIFICATE-----\n${'A'.repeat(60)}\n-----END CERTIFICATE-----`,
    INTERNAL_JOBS_SECRET: a,
    RATE_LIMIT_SALT: b,
    MONITOR_SECRET: c,
    SESSION_COOKIE_SECRET: `${c}-cookie`,
    TRACKING_TOKEN_SECRET: `${a}-tracking`,
    SUPABASE_URL: 'https://proyecto.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_publica_0123456789',
    SUPABASE_SERVICE_ROLE_KEY: `svc-${b}`,
    STRIPE_API_VERSION: '2026-01-01',
    STRIPE_CONNECT_WEBHOOK_SECRET: `whsec_${a}`,
    STRIPE_PLATFORM_WEBHOOK_SECRET: `whsec_p_${a}`,
    PACKLINK_API_KEY: `pk_${b}`,
    PACKLINK_WEBHOOK_SECRET: `pw_${a}`,
    RESEND_API_KEY: `re_${b}`,
    EMAIL_FROM: 'avisos@example.com',
    OPERATOR_EMAIL: 'operador@example.com',
    EMAIL_SANDBOX_REDIRECT: 'pruebas@example.com',
    PAYOUT_MODE: 'manual',
    CONTACT_EMAIL: 'contacto@example.com',
    OPERATOR_EMAILS: 'op@example.com',
    OPERATOR_TOTP_SECRETS: 'op@example.com:JBSWY3DPEHPK3PXP',
    OPERATOR_SESSION_SECRET: 's'.repeat(40),
  });

  it('rechaza live con clave de prueba y sandbox con clave real', () => {
    fc.assert(
      fc.property(secretArb, secretArb, secretArb, secretArb, keySuffix, (a, b, c, d, k) => {
        const env = baseEnv(a, b, c, d);
        expect(loadConfig({ ...env, APP_ENV: 'live', STRIPE_SECRET_KEY: `sk_test_${k}` }).ok).toBe(
          false,
        );
        expect(
          loadConfig({ ...env, APP_ENV: 'sandbox', STRIPE_SECRET_KEY: `sk_live_${k}` }).ok,
        ).toBe(false);
        expect(
          loadConfig({ ...env, APP_ENV: 'sandbox', STRIPE_SECRET_KEY: `sk_test_${k}` }).ok,
        ).toBe(true);
        expect(
          loadConfig({
            ...env,
            APP_ENV: 'live',
            APP_URL: 'https://x.es',
            STRIPE_SECRET_KEY: `sk_live_${k}`,
          }).ok,
        ).toBe(true);
      }),
    );
  });

  it('una configuracion aceptada nunca expone secretos al serializarse; los errores tampoco', () => {
    fc.assert(
      fc.property(secretArb, secretArb, secretArb, secretArb, keySuffix, (a, b, c, d, k) => {
        const env = {
          ...baseEnv(a, b, c, d),
          APP_ENV: 'sandbox',
          STRIPE_SECRET_KEY: `sk_test_${k}`,
        };
        const ok = loadConfig(env);
        expect(ok.ok).toBe(true);
        if (ok.ok) {
          const text = `${JSON.stringify(ok.value)}${String(ok.value.databaseUrl)}`;
          for (const s of [a, b, c, d, k, `svc-${b}`, `whsec_${a}`, `${c}-cookie`]) {
            expect(text).not.toContain(s);
          }
        }
        const bad = loadConfig({ ...env, APP_ENV: 'live', STRIPE_SECRET_KEY: `sk_test_${k}` });
        expect(bad.ok).toBe(false);
        if (!bad.ok)
          for (const s of [a, b, c, d, k]) expect(JSON.stringify(bad.error)).not.toContain(s);
      }),
    );
  });
});
