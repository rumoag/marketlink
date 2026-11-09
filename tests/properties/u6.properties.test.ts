import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MS } from '@/modules/kernel/domain/clock';
import {
  ABSOLUTE_MS,
  IDLE_MS,
  decodeSession,
  encodeSession,
  type OperatorSession,
} from '@/modules/operator/domain/operator-session';
import {
  LOW_DATA_ORDERS,
  computeMetrics,
  countsAsVisit,
  validateSize,
  type RawMetrics,
} from '@/modules/operator/domain/settings-and-metrics';
import { STUCK_REASONS, stuckReason, type StuckInput } from '@/modules/operator/domain/stuck';
import {
  TOTP_STEP_SECONDS,
  base32Encode,
  generateSecret,
  stepOf,
  totpAtStep,
  verifyTotp,
} from '@/modules/operator/domain/totp';
import { ORDER_STATUSES } from '@/modules/orders/domain/order';
import { loadConfig } from '@/modules/platform/application/config';
import { OP_EMAIL, buildU6 } from '@tests/support/u6-harness';

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const secret = fc.uint8Array({ minLength: 10, maxLength: 32 }).map(base32Encode);

describe('P-U6-01 a 03 TOTP', () => {
  it('acepta exactamente los códigos de la ventana ±1 y rechaza el resto', () => {
    fc.assert(
      fc.property(
        secret,
        fc.integer({ min: 5, max: 50_000_000 }),
        fc.integer({ min: -5, max: 5 }),
        (s, step, delta) => {
          const code = totpAtStep(s, step + delta) as string;
          const v = verifyTotp(s, code, step * TOTP_STEP_SECONDS * 1000 + 1000, 0);
          // Un código de otro paso puede coincidir por azar con uno de la ventana: se comprueba el paso aceptado.
          if (v.ok) expect(Math.abs(v.step - step)).toBeLessThanOrEqual(1);
          if (Math.abs(delta) <= 1) expect(v.ok).toBe(true);
          if (Math.abs(delta) >= 2 && !v.ok) expect(v.reason).toBe('invalid');
        },
      ),
    );
  });

  it('un código ya usado (o de un paso anterior al último aceptado) nunca se acepta de nuevo', () => {
    fc.assert(
      fc.property(secret, fc.integer({ min: 5, max: 50_000_000 }), (s, step) => {
        const now = step * TOTP_STEP_SECONDS * 1000 + 500;
        const code = totpAtStep(s, step) as string;
        const first = verifyTotp(s, code, now, 0);
        expect(first).toEqual({ ok: true, step });
        const again = verifyTotp(s, code, now, step);
        expect(again).toEqual({ ok: false, reason: 'reused' });
      }),
    );
  });

  it('rechaza cualquier formato que no sean 6 dígitos y secretos inválidos', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        fc.pre(!/^\d{6}$/.test(text));
        expect(verifyTotp(generateSecret(), text, NOW, 0)).toEqual({ ok: false, reason: 'format' });
      }),
    );
    expect(verifyTotp('!!!', '123456', NOW, 0).ok).toBe(false);
    expect(stepOf(NOW)).toBeGreaterThan(0);
  });
});

describe('P-U6-04 sesión firmada y caducidad', () => {
  const key = 'k'.repeat(40);
  const session = (over: Partial<OperatorSession> = {}): OperatorSession => ({
    email: OP_EMAIL,
    createdAt: NOW,
    lastActivityAt: NOW,
    stage: 'completa',
    ...over,
  });

  it('ida y vuelta, y cualquier alteración o clave distinta se rechaza', () => {
    fc.assert(
      fc.property(fc.emailAddress(), fc.integer({ min: 0, max: 1000 }), (email, pos) => {
        const cookie = encodeSession(key, session({ email }));
        expect(decodeSession(key, cookie, NOW)).toEqual({ ok: true, session: session({ email }) });
        expect(decodeSession('otra-clave-'.repeat(4), cookie, NOW).ok).toBe(false);
        const i = pos % cookie.length;
        const swapped = cookie[i] === 'A' ? 'B' : 'A';
        const tampered = cookie.slice(0, i) + swapped + cookie.slice(i + 1);
        expect(decodeSession(key, tampered, NOW).ok).toBe(false);
      }),
    );
  });

  it('caduca por inactividad, por antigüedad y la etapa pendiente dura poco', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 12 * 60 }),
        fc.integer({ min: 0, max: 12 * 60 }),
        (idleMin, ageMin) => {
          fc.pre(ageMin >= idleMin);
          const s = session({
            createdAt: NOW - ageMin * MS.minute,
            lastActivityAt: NOW - idleMin * MS.minute,
          });
          const v = decodeSession(key, encodeSession(key, s), NOW);
          const expired = idleMin * MS.minute > IDLE_MS || ageMin * MS.minute > ABSOLUTE_MS;
          expect(v.ok).toBe(!expired);
        },
      ),
    );
    const pending = session({ stage: 'pendiente_mfa', createdAt: NOW - 11 * MS.minute });
    expect(decodeSession(key, encodeSession(key, pending), NOW).ok).toBe(false);
  });
});

describe('P-U6-05 y 06 acceso', () => {
  it('quitar el email de la lista cierra la sesión en la siguiente petición', async () => {
    const u = buildU6();
    const cookie = u.sessions.issue(OP_EMAIL, 'completa').split(';')[0]!;
    const headers = new Headers({ cookie });
    expect(await u.sessions.resolve(headers)).not.toBeNull();
    const removed = new (u.sessions.constructor as new (o: unknown) => typeof u.sessions)({
      secret: 's'.repeat(40),
      directory: { isAuthorized: () => false, totpSecret: () => undefined, all: () => [] },
      clock: u.clock,
      secure: true,
    });
    expect(await removed.resolve(headers)).toBeNull();
  });

  it('pedir el enlace deja el mismo rastro para cualquier email (misma forma de trabajo y de respuesta)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.emailAddress(), fc.string()), async (raw) => {
        const u = buildU6();
        const known = await u.requestLink.execute(OP_EMAIL, '1.1.1.1', 'c');
        const other = await u.requestLink.execute(raw, '1.1.1.2', 'c');
        expect(other).toEqual(known);
        const [a, b] = u.jobs;
        expect(a?.type).toBe(b?.type);
        expect(Object.keys(a?.payload ?? {})).toEqual(Object.keys(b?.payload ?? {}));
        if (raw.trim().toLowerCase() !== OP_EMAIL) expect(b?.payload.email).toBeNull();
      }),
      { numRuns: 60 },
    );
  });
});

describe('P-U6-07 atasco como función pura', () => {
  const input = fc.record({
    status: fc.constantFrom(...ORDER_STATUSES),
    updatedAt: fc.integer({ min: NOW - 30 * 24 * MS.hour, max: NOW }),
    manualFlagOpen: fc.boolean(),
    shipmentStatus: fc.constantFrom(
      'creando',
      'borrador',
      'etiqueta_lista',
      'en_transito',
      'entregado',
      undefined,
    ),
    draftCreatedAt: fc.option(fc.integer({ min: NOW - 10 * 24 * MS.hour, max: NOW }), {
      nil: undefined,
    }),
    pickupChosen: fc.boolean(),
    pickupRequestedAt: fc.option(fc.integer({ min: NOW - 10 * 24 * MS.hour, max: NOW }), {
      nil: undefined,
    }),
    settlementBlocked: fc.boolean(),
  }) as fc.Arbitrary<StuckInput>;

  it('es determinista, respeta la prioridad y devuelve solo motivos conocidos', () => {
    fc.assert(
      fc.property(input, (i) => {
        const r = stuckReason(i, NOW, 10);
        expect(stuckReason(i, NOW, 10)).toBe(r);
        if (r !== undefined) expect(STUCK_REASONS).toContain(r);
        if (i.manualFlagOpen) expect(r).toBe('incidencia_manual');
        if (!i.manualFlagOpen && i.status === 'error_borrador') expect(r).toBe('error_borrador');
      }),
    );
  });

  it('un pedido no atascado nunca se vuelve atascado al retroceder el reloj', () => {
    fc.assert(
      fc.property(input, fc.integer({ min: 0, max: 5 * 24 }), (i, backHours) => {
        const later = stuckReason(i, NOW, 10);
        const earlier = stuckReason(i, NOW - backHours * MS.hour, 10);
        // Con la misma fila, retroceder el reloj solo puede quitar motivos de antigüedad.
        if (later === undefined) expect(earlier).toBeUndefined();
      }),
    );
  });
});

describe('P-U6-09 y 10 métricas', () => {
  const raw = fc
    .record({
      listingsCreated: fc.nat(500),
      views: fc.nat(100_000),
      paidOrders: fc.nat(500),
      cardOrders: fc.nat(500),
      bizumOrders: fc.nat(500),
      puntoOrders: fc.nat(500),
      recogidaOrders: fc.nat(500),
      shippingChargedCents: fc.nat(10_000_000),
      labelCostCents: fc.nat(10_000_000),
      ordersWithLabelCost: fc.nat(500),
      payToLabelMsTotal: fc.nat(10 ** 12),
      payToLabelCount: fc.nat(500),
      incidents: fc.nat(100),
      artistsWithOrders: fc.nat(100),
      repeatArtists: fc.nat(100),
    })
    .map((r): RawMetrics => r);

  it('los porcentajes están entre 0 y 100, los complementarios suman 100 y la conversión no pasa de 100', () => {
    fc.assert(
      fc.property(raw, (r) => {
        const m = computeMetrics(r);
        for (const p of [m.conversionPct, m.cardPct, m.bizumPct, m.puntoPct, m.recogidaPct]) {
          if (p !== undefined) {
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(100);
          }
        }
        if (m.cardPct !== undefined && m.bizumPct !== undefined) {
          expect(Math.abs(m.cardPct + m.bizumPct - 100)).toBeLessThanOrEqual(0.11);
        }
        if (m.puntoPct !== undefined && m.recogidaPct !== undefined) {
          expect(Math.abs(m.puntoPct + m.recogidaPct - 100)).toBeLessThanOrEqual(0.11);
        }
        expect(m.conversionPct === undefined).toBe(r.views === 0);
        expect(m.lowData).toBe(r.paidOrders < LOW_DATA_ORDERS);
      }),
    );
  });
});

describe('P-U6-11 visitas y P-U6-12 tamaños', () => {
  it('nunca cuenta robots, precargas ni a la propia artista, ni sin User-Agent', () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), (ua, artist) => {
        const bot =
          /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|curl|wget|python-requests|headless/i.test(
            ua,
          );
        const counted = countsAsVisit({ userAgent: ua, purpose: null, hasArtistSession: artist });
        if (bot || artist || ua.trim() === '') expect(counted).toBe(false);
        else expect(counted).toBe(true);
      }),
    );
    expect(countsAsVisit({ userAgent: null, purpose: null, hasArtistSession: false })).toBe(false);
    expect(
      countsAsVisit({ userAgent: 'Mozilla/5.0', purpose: 'prefetch', hasArtistSession: false }),
    ).toBe(false);
  });

  it('un tamaño válido respeta rangos y coherencia; todo lo demás se rechaza', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5, max: 200 }),
        fc.integer({ min: -5, max: 200 }),
        fc.integer({ min: -5, max: 200 }),
        fc.double({ min: -1, max: 40, noNaN: true }),
        (l, w, h, kg) => {
          const r = validateSize({
            lengthCm: l,
            widthCm: w,
            heightCm: h,
            weightKg: Math.round(kg * 100) / 100,
          });
          if (r.ok) {
            for (const v of [l, w, h]) {
              expect(v).toBeGreaterThanOrEqual(5);
              expect(v).toBeLessThanOrEqual(150);
            }
            expect(Math.round(kg * 100) / 100).toBeGreaterThanOrEqual(0.1);
            const [a = 0, b = 0, c = 0] = [l, w, h].sort((x, y) => y - x);
            expect(a + 2 * (b + c)).toBeLessThanOrEqual(300);
          }
        },
      ),
    );
  });
});

describe('Configuración del operador', () => {
  const base = {
    APP_ENV: 'sandbox',
    E2E_ENABLED: 'true',
    DATABASE_URL: 'postgres://u:p@h:6543/db',
    INTERNAL_JOBS_SECRET: 'a'.repeat(40),
    RATE_LIMIT_SALT: 'b'.repeat(40),
    SESSION_COOKIE_SECRET: 'c'.repeat(40),
    TRACKING_TOKEN_SECRET: 'd'.repeat(40),
  };
  it('sin variables el panel queda desactivado; con pares válidos se activa', () => {
    const none = loadConfig(base);
    expect(none.ok && none.value.operator).toBeUndefined();
    const ok = loadConfig({
      ...base,
      OPERATOR_EMAILS: 'Op@Example.com',
      OPERATOR_TOTP_SECRETS: 'op@example.com:JBSWY3DPEHPK3PXP',
      OPERATOR_SESSION_SECRET: 's'.repeat(40),
    });
    expect(ok.ok && ok.value.operator?.emails).toEqual(['op@example.com']);
    expect(ok.ok && ok.value.operator?.totpSecrets.get('op@example.com')?.reveal()).toBe(
      'JBSWY3DPEHPK3PXP',
    );
  });
  it('rechaza emails sin secreto, secretos mal formados y secreto de sesión corto, sin revelar valores', () => {
    for (const env of [
      {
        OPERATOR_EMAILS: 'op@example.com',
        OPERATOR_TOTP_SECRETS: 'otro@example.com:JBSWY3DPEHPK3PXP',
        OPERATOR_SESSION_SECRET: 's'.repeat(40),
      },
      {
        OPERATOR_EMAILS: 'op@example.com',
        OPERATOR_TOTP_SECRETS: 'op@example.com:no-es-base32!',
        OPERATOR_SESSION_SECRET: 's'.repeat(40),
      },
      {
        OPERATOR_EMAILS: 'op@example.com',
        OPERATOR_TOTP_SECRETS: 'op@example.com:JBSWY3DPEHPK3PXP',
        OPERATOR_SESSION_SECRET: 'corto',
      },
      {
        OPERATOR_EMAILS: 'no-es-email',
        OPERATOR_TOTP_SECRETS: 'op@example.com:JBSWY3DPEHPK3PXP',
        OPERATOR_SESSION_SECRET: 's'.repeat(40),
      },
    ]) {
      const r = loadConfig({ ...base, ...env });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(JSON.stringify(r.error)).not.toMatch(/JBSWY3DPEHPK3PXP|no-es-base32/);
    }
  });
  it('en live es obligatorio', () => {
    const live = loadConfig({
      ...base,
      APP_ENV: 'live',
      E2E_ENABLED: 'false',
      SUPABASE_URL: 'https://p.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_publica_0123456789',
      SUPABASE_SERVICE_ROLE_KEY: 'svc-0123456789',
      STRIPE_SECRET_KEY: 'sk_live_0123456789abcdef',
      STRIPE_API_VERSION: '2026-01-01',
      STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_0123456789',
      STRIPE_PLATFORM_WEBHOOK_SECRET: 'whsec_p_0123456789',
      PACKLINK_API_KEY: 'pk_0123456789',
      PACKLINK_WEBHOOK_SECRET: 'pw_0123456789abcdef',
      RESEND_API_KEY: 're_0123456789',
      EMAIL_FROM: 'avisos@example.com',
      OPERATOR_EMAIL: 'operador@example.com',
      PAYOUT_MODE: 'manual',
      CONTACT_EMAIL: 'contacto@example.com',
      APP_URL: 'https://app.example.com',
    });
    expect(live.ok).toBe(false);
    if (!live.ok) expect(live.error.issues.some((i) => i.startsWith('OPERATOR_'))).toBe(true);
  });
});
