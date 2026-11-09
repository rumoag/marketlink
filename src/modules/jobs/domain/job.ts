import { addMs, MS, type Instant } from '@/modules/kernel/domain/clock';

/** Ciclo de vida de un trabajo (BR-J1 a BR-J9, seccion 1 de business-logic-model.md). */
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];
export const isTerminal = (status: JobStatus): boolean => TERMINAL_STATUSES.includes(status);

/** Ejecucion inicial mas 5 reintentos (BR-J8). */
export const MAX_ATTEMPTS = 6;

/** Bloqueo de un trabajo en ejecucion (BR-J5). */
export const LEASE_MS = 5 * MS.minute;

/** BR-J1: esperas tras el intento 1 a 5. Sin dispersion aleatoria en el v0. */
export const RETRY_WAITS_MS: readonly number[] = [
  1 * MS.minute,
  5 * MS.minute,
  30 * MS.minute,
  2 * MS.hour,
  12 * MS.hour,
];

/** Espera antes de reintentar tras haber consumido `attempts` intentos; undefined si no quedan. */
export const retryWaitMs = (attempts: number): number | undefined =>
  attempts >= 1 && attempts <= RETRY_WAITS_MS.length ? RETRY_WAITS_MS[attempts - 1] : undefined;

export type Job = {
  readonly id: string;
  readonly type: string;
  /** Solo identificadores y datos minimos: sin datos personales (BR-J9). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly dedupeKey: string | undefined;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly runAt: Instant;
  readonly leaseUntil: Instant | undefined;
  readonly lastError: string | undefined;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly completedAt: Instant | undefined;
};

export type NewJob = {
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly dedupeKey?: string;
  readonly runAt?: Instant;
};

/** Resultado de un manejador: Ok, error reintentable o error permanente (BR-J3). */
export type JobError = { readonly retryable: boolean; readonly message: string };

export type Resolution =
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'retry'; readonly runAt: Instant; readonly lastError: string }
  | { readonly kind: 'failed'; readonly lastError: string };

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: JobError };

/**
 * Decide que hacer con un trabajo tras ejecutarlo. `job.attempts` ya incluye el intento actual
 * (se suma al reclamar). Los reintentos agotados o el error permanente llevan a `failed`.
 */
export const resolveOutcome = (
  job: Pick<Job, 'attempts'>,
  outcome: Outcome,
  now: Instant,
): Resolution => {
  if (outcome.ok) return { kind: 'succeeded' };
  const wait = outcome.error.retryable ? retryWaitMs(job.attempts) : undefined;
  if (wait === undefined) return { kind: 'failed', lastError: outcome.error.message };
  return { kind: 'retry', runAt: addMs(now, wait), lastError: outcome.error.message };
};

/** BR-J6: un bloqueo vencido consume el intento ya sumado al reclamar. */
export const resolveExpiredLease = (job: Pick<Job, 'attempts'>, now: Instant): Resolution =>
  resolveOutcome(job, { ok: false, error: { retryable: true, message: 'lease_expired' } }, now);
