import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { instantOf, MS } from '@/modules/kernel/domain/clock';
import {
  evaluateSecurity,
  healthStatus,
  hourBucket,
  privacyFacts,
  quotaReviewStatus,
  type HealthSignals,
} from '@/modules/operator/domain/health';
import { ORDER_STATUSES } from '@/modules/orders/domain/order';
import {
  ACTIVE_CHAIN,
  addMonthsUtc,
  isRetentionDue,
  purgeBlock,
  retentionReference,
} from '@/modules/orders/domain/retention';
import { buildU7 } from '@tests/support/u7-harness';

const NOW = Date.UTC(2027, 5, 15, 12, 0, 0);
const instant = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2030, 0, 1) }).map(instantOf);

describe('P-U7-01 a 04 retención', () => {
  it('el plazo vence exactamente a los N meses calendario y es monótono en el tiempo', () => {
    fc.assert(
      fc.property(
        instant,
        fc.integer({ min: 1, max: 36 }),
        fc.integer({ min: 0, max: 40 }),
        (ref, months, extraDays) => {
          const due = addMonthsUtc(ref, months);
          expect(due).toBeGreaterThan(ref);
          expect(isRetentionDue(ref, instantOf(due - 1), months)).toBe(false);
          expect(isRetentionDue(ref, due, months)).toBe(true);
          expect(isRetentionDue(ref, instantOf(due + extraDays * MS.day), months)).toBe(true);
          // Un mes dura entre 28 y 31 dias: el vencimiento queda dentro de esos limites.
          const days = (due - ref) / MS.day;
          expect(days).toBeGreaterThanOrEqual(27.99 * months);
          expect(days).toBeLessThanOrEqual(31.01 * months);
        },
      ),
    );
  });

  it('la fecha de referencia es la entrega, si no el pago y si no la creación', () => {
    fc.assert(
      fc.property(
        fc.option(instant, { nil: undefined }),
        fc.option(instant, { nil: undefined }),
        instant,
        (d, p, c) => {
          const r = retentionReference({ deliveredAt: d, paidAt: p, createdAt: c });
          expect(r).toBe(d ?? p ?? c);
        },
      ),
    );
  });

  it('la limpieza espera con cualquier causa y la petición protege además la cadena activa', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ORDER_STATUSES),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (status, refund, flag, settle) => {
          const ctx = {
            status,
            refundPending: refund,
            manualFlagOpen: flag,
            settlementPending: settle,
          };
          const retention = purgeBlock('retention', ctx);
          const onDemand = purgeBlock('on_demand', ctx);
          if (retention === undefined) {
            expect(refund || flag || settle || status === 'incidencia').toBe(false);
          } else {
            expect(onDemand).toBeDefined();
          }
          if (ACTIVE_CHAIN.includes(status)) expect(onDemand).toBeDefined();
          if (
            !refund &&
            !flag &&
            !settle &&
            status !== 'incidencia' &&
            !ACTIVE_CHAIN.includes(status) &&
            status !== 'pendiente_pago'
          ) {
            expect(onDemand).toBeUndefined();
          }
        },
      ),
    );
  });
});

describe('P-U7-06 y 07 alertas', () => {
  const thresholds = fc.record({
    authFailures: fc.integer({ min: 1, max: 50 }),
    authzDenied: fc.integer({ min: 1, max: 50 }),
    webhookSignatures: fc.integer({ min: 1, max: 50 }),
  });
  const counts = fc.record({
    authFailures: fc.nat(100),
    authzDenied: fc.nat(100),
    webhookSignatures: fc.nat(100),
    operatorLocked: fc.nat(5),
  });

  it('hay un hallazgo por tipo si y solo si se alcanza el umbral exacto', () => {
    fc.assert(
      fc.property(counts, thresholds, (c, t) => {
        const types = evaluateSecurity(c, t).map((f) => f.type);
        expect(types.includes('seguridad_autenticacion')).toBe(c.authFailures >= t.authFailures);
        expect(types.includes('seguridad_autorizacion')).toBe(c.authzDenied >= t.authzDenied);
        expect(types.includes('seguridad_webhook')).toBe(
          c.webhookSignatures >= t.webhookSignatures,
        );
        expect(types.includes('acceso_operador_bloqueado')).toBe(c.operatorLocked >= 1);
        expect(new Set(types).size).toBe(types.length);
      }),
    );
  });

  it('la franja es la hora natural: igual dentro de la hora y distinta fuera', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 12 }),
        fc.integer({ min: 0, max: 3_599_999 }),
        (base, off) => {
          const start = Math.floor(base / MS.hour) * MS.hour;
          expect(hourBucket(start + off)).toBe(hourBucket(start));
          expect(hourBucket(start + MS.hour)).not.toBe(hourBucket(start));
        },
      ),
    );
  });

  it('con cualquier secuencia de ejecuciones nunca se avisa dos veces el mismo tipo en la misma franja', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            advanceMin: fc.integer({ min: 0, max: 40 }),
            auth: fc.nat(6),
            authz: fc.nat(6),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (steps) => {
          const u = buildU7();
          const seen = new Map<string, number>();
          for (const step of steps) {
            u.clock.advance(step.advanceMin * MS.minute);
            u.securityEvent('auth_failure', step.auth);
            u.securityEvent('authz_denied', step.authz);
            const { alerted } = await u.security.execute('c');
            for (const type of alerted) {
              const key = `${type}|${hourBucket(u.clock.now())}`;
              seen.set(key, (seen.get(key) ?? 0) + 1);
            }
          }
          for (const n of seen.values()) expect(n).toBe(1);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('P-U7-08 salud monótona', () => {
  const signals = fc.record({
    dbOk: fc.boolean(),
    failedJobs24h: fc.nat(5),
    failedEmails: fc.nat(5),
    backupAgeHours: fc.option(fc.integer({ min: 0, max: 200 }), { nil: undefined }),
    openCircuits: fc.nat(4),
    quotasStale: fc.boolean(),
    live: fc.boolean(),
  }) as fc.Arbitrary<HealthSignals>;
  const rank = { verde: 0, ambar: 1, rojo: 2 } as const;

  it('empeorar cualquier señal nunca mejora el estado', () => {
    fc.assert(
      fc.property(
        signals,
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 1, max: 30 }),
        (s, which, delta) => {
          const worse: HealthSignals = (() => {
            switch (which) {
              case 0:
                return { ...s, dbOk: false };
              case 1:
                return { ...s, failedJobs24h: s.failedJobs24h + delta };
              case 2:
                return { ...s, failedEmails: s.failedEmails + delta };
              case 3:
                return { ...s, backupAgeHours: (s.backupAgeHours ?? 0) + delta };
              case 4:
                return { ...s, openCircuits: s.openCircuits + delta };
              default:
                return { ...s, quotasStale: true };
            }
          })();
          expect(rank[healthStatus(worse).state]).toBeGreaterThanOrEqual(
            rank[healthStatus(s).state],
          );
        },
      ),
    );
  });

  it('verde solo sin motivos; ámbar y rojo siempre explican por qué', () => {
    fc.assert(
      fc.property(signals, (s) => {
        const h = healthStatus(s);
        expect(h.state === 'verde').toBe(h.reasons.length === 0);
      }),
    );
  });

  it('la revisión de cuotas vence a los 35 días', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (days) => {
        expect(quotaReviewStatus(NOW - days * MS.day, NOW)).toBe(days > 35 ? 'vencida' : 'al_dia');
      }),
    );
    expect(quotaReviewStatus(undefined, NOW)).toBe('vencida');
  });
});

describe('P-U7-09 textos legales', () => {
  it('los plazos y el contacto del texto salen de la configuración', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 365 }),
        fc.integer({ min: 1, max: 15 }),
        fc.emailAddress(),
        (personalMonths, unpaidDays, financialYears, contactEmail) => {
          const f = privacyFacts({ personalMonths, unpaidDays, financialYears, contactEmail });
          expect(f.retention).toContain(`${personalMonths} meses`);
          expect(f.unpaid).toContain(`${unpaidDays} días`);
          expect(f.financial).toContain(`${financialYears} años`);
          expect(f.rights).toContain(contactEmail);
        },
      ),
    );
  });
});
