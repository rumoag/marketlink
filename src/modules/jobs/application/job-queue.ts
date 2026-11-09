import type { Clock, Instant } from '@/modules/kernel/domain/clock';
import { redact } from '@/modules/platform/domain/redactor';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { OperatorNotifier } from '@/modules/platform/application/operator-notifier';
import type { Logger } from '@/modules/platform/application/ports';
import {
  LEASE_MS,
  resolveExpiredLease,
  resolveOutcome,
  type Job,
  type JobError,
  type NewJob,
  type Outcome,
  type Resolution,
} from '../domain/job';

/** Puerto de persistencia. Cada operacion es atomica en el almacen (BR-J5, BR-J7). */
export interface JobStore {
  /** Crea el trabajo o devuelve el no terminal existente con la misma dedupeKey (BR-J7). */
  enqueue(input: NewJob, now: Instant): Promise<Job>;
  /** Reclama de forma exclusiva trabajos listos: running, attempts+1, leaseUntil (BR-J5). */
  claim(now: Instant, limit: number, leaseMs: number): Promise<Job[]>;
  complete(id: string, now: Instant): Promise<void>;
  reschedule(id: string, runAt: Instant, lastError: string, now: Instant): Promise<void>;
  fail(id: string, lastError: string, now: Instant): Promise<void>;
  /** Toma de forma exclusiva los running con bloqueo vencido para que la cola decida (BR-J6). */
  takeExpired(now: Instant, limit: number, leaseMs: number): Promise<Job[]>;
}

export type JobContext = { readonly correlationId: string; readonly logger: Logger };
export type JobHandler = (job: Job, ctx: JobContext) => Promise<Outcome>;

export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(type: string, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  get(type: string): JobHandler | undefined {
    return this.handlers.get(type);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }
}

export type BatchSummary = {
  readonly claimed: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly failed: number;
  readonly recovered: number;
};

export type JobQueueDeps = {
  readonly store: JobStore;
  readonly registry: JobHandlerRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditLog;
  readonly notifier: OperatorNotifier;
};

const MAX_ERROR_LENGTH = 500;

/** BR-J9: el ultimo error se guarda redactado y acotado. */
export const sanitizeError = (message: string): string => {
  const safe = redact(message);
  return (typeof safe === 'string' ? safe : '[REDACTED]').slice(0, MAX_ERROR_LENGTH);
};

export class JobQueue {
  constructor(private readonly deps: JobQueueDeps) {}

  /** Encola un trabajo; con dedupeKey repetida devuelve el existente no terminal (BR-J7). */
  enqueue(input: NewJob): Promise<Job> {
    return this.deps.store.enqueue(input, this.deps.clock.now());
  }

  /**
   * Procesa un lote: recupera bloqueos vencidos, reclama trabajos listos y los resuelve.
   * Para si se supera el presupuesto de tiempo, para no agotar la funcion serverless.
   */
  async runBatch(options: {
    correlationId: string;
    limit?: number;
    budgetMs?: number;
  }): Promise<BatchSummary> {
    const { correlationId } = options;
    const limit = options.limit ?? 10;
    const budgetMs = options.budgetMs ?? 25_000;
    const started = this.deps.clock.now();
    const logger = this.deps.logger.child({ correlationId });
    let succeeded = 0;
    let retried = 0;
    let failed = 0;

    const recovered = await this.recoverExpired(correlationId);
    failed += recovered.failed;
    retried += recovered.retried;

    const claimed = await this.deps.store.claim(this.deps.clock.now(), limit, LEASE_MS);
    for (const job of claimed) {
      if (this.deps.clock.now() - started > budgetMs) {
        // Sin tiempo: se devuelve al ciclo siguiente por vencimiento del bloqueo (consume intento).
        logger.warn('job_batch_budget_exhausted', { jobId: job.id });
        break;
      }
      const resolution = await this.execute(job, { correlationId, logger });
      if (resolution.kind === 'succeeded') succeeded += 1;
      else if (resolution.kind === 'retry') retried += 1;
      else failed += 1;
    }
    return { claimed: claimed.length, succeeded, retried, failed, recovered: recovered.total };
  }

  private async execute(job: Job, ctx: JobContext): Promise<Resolution> {
    const startedAt = this.deps.clock.now();
    const handler = this.deps.registry.get(job.type);

    let outcome: Outcome;
    if (!handler) {
      // BR-J4: sin manejador es un error permanente.
      outcome = { ok: false, error: { retryable: false, message: 'handler_not_found' } };
    } else {
      try {
        outcome = await handler(job, ctx);
      } catch (e) {
        // Una excepcion se trata como error reintentable con mensaje saneado (BR-R1).
        const message = e instanceof Error ? e.name : 'unknown_error';
        outcome = { ok: false, error: { retryable: true, message } satisfies JobError };
      }
    }

    const now = this.deps.clock.now();
    const resolution = resolveOutcome(job, outcome, now);
    await this.apply(job, resolution, now);

    ctx.logger.info('job_executed', {
      jobId: job.id,
      type: job.type,
      attempt: job.attempts,
      result: resolution.kind,
      durationMs: now - startedAt,
    });
    return resolution;
  }

  private async recoverExpired(
    correlationId: string,
  ): Promise<{ total: number; retried: number; failed: number }> {
    const now = this.deps.clock.now();
    const expired = await this.deps.store.takeExpired(now, 50, LEASE_MS);
    let retried = 0;
    let failed = 0;
    for (const job of expired) {
      const resolution = resolveExpiredLease(job, now);
      await this.apply(job, resolution, now, correlationId);
      if (resolution.kind === 'retry') retried += 1;
      else failed += 1;
    }
    return { total: expired.length, retried, failed };
  }

  private async apply(
    job: Job,
    resolution: Resolution,
    now: Instant,
    correlationId = 'job-runner',
  ): Promise<void> {
    const { store } = this.deps;
    if (resolution.kind === 'succeeded') {
      await store.complete(job.id, now);
    } else if (resolution.kind === 'retry') {
      await store.reschedule(job.id, resolution.runAt, sanitizeError(resolution.lastError), now);
    } else {
      const lastError = sanitizeError(resolution.lastError);
      await store.fail(job.id, lastError, now);
      // BR-J2: agotar intentos o error permanente deja AuditEvent y alerta.
      await this.deps.audit.record({
        actorType: 'system',
        action: 'job_failed',
        resourceType: 'job',
        resourceId: job.id,
        outcome: 'failure',
        correlationId,
        details: { type: job.type, attempts: job.attempts, error: lastError },
      });
      await this.deps.notifier.notify({
        severity: 'critical',
        title: 'Trabajo fallido',
        correlationId,
        details: { jobId: job.id, type: job.type, attempts: job.attempts },
      });
    }
  }
}
