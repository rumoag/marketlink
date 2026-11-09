import { MS, type Clock } from '@/modules/kernel/domain/clock';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { OperatorAlerts } from '@/modules/orders/application/ports';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { Logger } from '@/modules/platform/application/ports';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import {
  AUDIT_ROWS_LIMIT,
  evaluateSecurity,
  healthStatus,
  hourBucket,
  quotaReviewStatus,
  type HealthState,
  type SecurityThresholds,
} from '../domain/health';
import type { OperatorDirectory } from './access';
import type { JobSink, OperatorActor, OperatorRepos } from './ports';

export const JOB_SECURITY_ALERTS = 'security_alerts';
export const JOB_PURGE_PERSONAL_DATA = 'purge_personal_data';

type Runner = TransactionRunner<OperatorRepos>;

/**
 * BR7-AL1 y AL2: cada 5 minutos cuenta los eventos de seguridad de la ultima hora y avisa una
 * sola vez por tipo y franja. Los bloqueos del operador ya se avisan al producirse (U6).
 */
export class SecurityAlerts {
  constructor(
    private readonly deps: {
      readonly runner: Runner;
      readonly clock: Clock;
      readonly alerts: OperatorAlerts;
      readonly audit: AuditLog;
      readonly enqueue: JobSink;
      readonly logger: Logger;
      readonly thresholds: SecurityThresholds;
    },
  ) {}

  async execute(correlationId: string): Promise<{ alerted: string[] }> {
    const { deps } = this;
    const now = deps.clock.now();
    const bucket = hourBucket(now);
    const counts = await deps.runner.run(systemScope, (r) =>
      r.operator.securityCounts(now - MS.hour),
    );
    const findings = evaluateSecurity(counts, deps.thresholds).filter(
      (f) => f.type !== 'acceso_operador_bloqueado',
    );
    const alerted: string[] = [];
    for (const f of findings) {
      const already = await deps.runner.run(systemScope, (r) =>
        r.operator.hasAlertInBucket(f.type, bucket),
      );
      if (already) continue;
      await deps.alerts.raise(f.type, { detail: bucket }, correlationId);
      await deps.audit.record({
        actorType: 'system',
        action: 'security_alert',
        resourceType: 'security',
        resourceId: f.type,
        outcome: 'failure',
        correlationId,
        details: { count: f.count, threshold: f.threshold, bucket },
      });
      await deps.enqueue({
        type: 'operator_notice',
        payload: { kind: 'seguridad', alert: f.type, count: f.count, bucket, at: now },
        dedupeKey: `operator-notice:seguridad:${f.type}:${bucket}`,
      });
      alerted.push(f.type);
    }
    // Volumen de la auditoria (BR7-AL3): un aviso por franja de un dia.
    const rows = await deps.runner.run(systemScope, (r) => r.operator.auditRows());
    if (rows >= AUDIT_ROWS_LIMIT) {
      const day = bucket.slice(0, 10);
      const already = await deps.runner.run(systemScope, (r) =>
        r.operator.hasAlertInBucket('auditoria_voluminosa', day),
      );
      if (!already) {
        await deps.alerts.raise('auditoria_voluminosa', { detail: day }, correlationId);
        alerted.push('auditoria_voluminosa');
      }
    }
    return { alerted };
  }
}

// ---------------------------------------------------------------------------------------------
// Pantalla de salud (BR7-SL1, SL2)
// ---------------------------------------------------------------------------------------------
export type Section<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

export type CircuitView = {
  readonly provider: string;
  readonly state: 'closed' | 'open' | 'half_open';
};

export type HealthView = {
  readonly state: HealthState;
  readonly reasons: readonly string[];
  readonly db: Section<boolean>;
  readonly jobs: Section<{ failed24h: number; pending: number; running: number }>;
  readonly emails: Section<{ pending: number; failed: number }>;
  readonly work: Section<{
    stuck: number;
    unpaidDrafts: number;
    openFlags: number;
    blockedSettlements: number;
  }>;
  readonly alerts: Section<{ code: string; n: number }[]>;
  readonly audit: Section<number>;
  readonly circuits: Section<CircuitView[]>;
  readonly backup: Section<{ at: number; ageHours: number } | undefined>;
  readonly quotas: { reviewedAt: number | undefined; status: 'al_dia' | 'vencida' };
};

const SECTION_TIMEOUT_MS = 2000;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('failed'));
      },
    );
  });

export class GetHealth {
  constructor(
    private readonly deps: {
      readonly runner: Runner;
      readonly directory: OperatorDirectory;
      readonly clock: Clock;
      readonly logger: Logger;
      readonly staleDays: number;
      readonly circuits: () => CircuitView[];
      readonly quotasReviewedAt: () => number | undefined;
      readonly live: boolean;
    },
  ) {}

  private async section<T>(fn: () => Promise<T>): Promise<Section<T>> {
    try {
      return { ok: true, value: await withTimeout(fn(), SECTION_TIMEOUT_MS) };
    } catch (cause) {
      this.deps.logger.warn('health_section_failed', {
        reason: cause instanceof Error ? cause.message : 'unknown',
      });
      return { ok: false };
    }
  }

  async execute(actor: OperatorActor): Promise<Result<HealthView, AppError>> {
    const { deps } = this;
    if (!deps.directory.isAuthorized(actor.email)) return err(appError('forbidden'));
    const now = deps.clock.now();
    const run = <T>(fn: (r: OperatorRepos['operator']) => Promise<T>) =>
      this.section(() => deps.runner.run(systemScope, (r) => fn(r.operator)));
    const [db, jobs, emails, counts, blocked, alerts, audit, backup] = await Promise.all([
      run((o) => o.dbPing()),
      run((o) => o.jobStats(now)),
      run((o) => o.emailStats()),
      run((o) => o.counts(now, deps.staleDays)),
      run((o) => o.blockedSettlements()),
      run((o) => o.alertStats(now - 24 * MS.hour)),
      run((o) => o.auditRows()),
      run(async (o) => {
        const last = await o.lastBackup();
        return last ? { at: last.at, ageHours: Math.floor((now - last.at) / MS.hour) } : undefined;
      }),
    ]);
    const circuits = await this.section(() => Promise.resolve(deps.circuits()));
    const reviewedAt = deps.quotasReviewedAt();
    const quotas: HealthView['quotas'] = {
      reviewedAt,
      status: quotaReviewStatus(reviewedAt, now),
    };
    const work: HealthView['work'] =
      counts.ok && blocked.ok
        ? { ok: true, value: { ...counts.value, blockedSettlements: blocked.value } }
        : { ok: false };

    const status = healthStatus({
      dbOk: db.ok && db.value,
      failedJobs24h: jobs.ok ? jobs.value.failed24h : 0,
      failedEmails: emails.ok ? emails.value.failed : 0,
      backupAgeHours: backup.ok && backup.value ? backup.value.ageHours : undefined,
      openCircuits: circuits.ok ? circuits.value.filter((c) => c.state === 'open').length : 0,
      quotasStale: quotas.status === 'vencida',
      live: deps.live,
    });
    return ok({
      state: status.state,
      reasons: status.reasons,
      db,
      jobs,
      emails,
      work,
      alerts,
      audit,
      circuits,
      backup,
      quotas,
    });
  }
}
