import type { CircuitView } from '@/modules/operator/application/monitoring';
import { GetHealth, SecurityAlerts } from '@/modules/operator/application/monitoring';
import { ErasePersonalData, PurgePersonalData } from '@/modules/operator/application/privacy';
import type { OperatorAlerts } from '@/modules/orders/application/ports';
import { buildU6, deliver, paidU5Order, OP_EMAIL, type QueuedJob } from './u6-harness';

export const DEFAULT_THRESHOLDS = { authFailures: 10, authzDenied: 10, webhookSignatures: 5 };

export const buildU7 = (options: Parameters<typeof buildU6>[0] = {}) => {
  const u6 = buildU6(options);
  const { db, clock, audit, logger, limiter, directory } = u6;

  /** Los avisos quedan además en el «registro de alertas» que lee la deduplicación por franja. */
  const alerts: OperatorAlerts = {
    raise: async (code, context, correlationId) => {
      void correlationId;
      await u6.alerts.raise(code, context);
      db.state.alertLog.push({ code, bucket: context.detail ?? '' });
    },
  };

  const purge = new PurgePersonalData({ runner: db, clock, audit, alerts, logger, months: 12 });
  const security = new SecurityAlerts({
    runner: db,
    clock,
    alerts,
    audit,
    enqueue: (input) => {
      u6.jobs.push(input as QueuedJob);
      return Promise.resolve();
    },
    logger,
    thresholds: DEFAULT_THRESHOLDS,
  });

  let circuits: CircuitView[] = [
    { provider: 'stripe', state: 'closed' },
    { provider: 'packlink', state: 'closed' },
    { provider: 'resend', state: 'closed' },
    { provider: 'supabase', state: 'closed' },
  ];
  let reviewedAt: number | undefined = clock.now();
  const makeHealth = (live: boolean) =>
    new GetHealth({
      runner: db,
      directory,
      clock,
      logger,
      staleDays: 10,
      circuits: () => circuits,
      quotasReviewedAt: () => reviewedAt,
      live,
    });

  return {
    ...u6,
    privacy: purge,
    security,
    erase: new ErasePersonalData({ purge, directory, totp: u6.verifyTotp, limiter }),
    health: makeHealth(false),
    healthLive: makeHealth(true),
    setCircuits: (c: CircuitView[]) => {
      circuits = c;
    },
    setQuotasReviewedAt: (ms: number | undefined) => {
      reviewedAt = ms;
    },
    /** Eventos de seguridad ocurridos ahora en la auditoría simulada. */
    securityEvent: (action: string, n = 1, at: number = clock.now()) => {
      for (let i = 0; i < n; i += 1) db.state.securityEvents.push({ action, at });
    },
  };
};
export type U7 = ReturnType<typeof buildU7>;
export { deliver, paidU5Order, OP_EMAIL };
