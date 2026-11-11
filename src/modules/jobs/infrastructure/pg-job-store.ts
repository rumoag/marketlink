import { instantOf, type Instant } from '@/modules/kernel/domain/clock';
import type { Db } from '@/modules/platform/infrastructure/db-client';
import type { JobStore } from '../application/job-queue';
import type { Job, JobStatus, NewJob } from '../domain/job';
import { PERIODIC_JOB_TYPES } from '../domain/job';

type Row = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  status: JobStatus;
  attempts: number;
  run_at: Date;
  lease_until: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

const at = (d: Date): Instant => instantOf(d.getTime());
const atOrUndef = (d: Date | null): Instant | undefined => (d ? at(d) : undefined);
const ts = (t: Instant): Date => new Date(t);

const toJob = (r: Row): Job => ({
  id: r.id,
  type: r.type,
  payload: r.payload,
  dedupeKey: r.dedupe_key ?? undefined,
  status: r.status,
  attempts: r.attempts,
  runAt: at(r.run_at),
  leaseUntil: atOrUndef(r.lease_until),
  lastError: r.last_error ?? undefined,
  createdAt: at(r.created_at),
  updatedAt: at(r.updated_at),
  completedAt: atOrUndef(r.completed_at),
});

/** Cola en Postgres. El reclamo usa FOR UPDATE SKIP LOCKED para ser exclusivo (BR-J5). */
export class PgJobStore implements JobStore {
  constructor(private readonly db: Db) {}

  async enqueue(input: NewJob, now: Instant): Promise<Job> {
    const runAt = input.runAt ?? now;
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await this.db.query<Row>(
        `INSERT INTO jobs (type, payload, dedupe_key, status, attempts, run_at, created_at, updated_at)
         VALUES ($1, $2::jsonb, $3, 'pending', 0, $4, $5, $5)
         ON CONFLICT (dedupe_key) WHERE status IN ('pending', 'running') DO NOTHING
         RETURNING *`,
        [
          input.type,
          JSON.stringify(input.payload ?? {}),
          input.dedupeKey ?? null,
          ts(runAt),
          ts(now),
        ],
      );
      const row = inserted.rows[0];
      if (row) return toJob(row);

      // BR-J7: ya existe uno no terminal con esa clave. Si termino entre medias, se reintenta.
      const existing = await this.db.query<Row>(
        `SELECT * FROM jobs WHERE dedupe_key = $1 AND status IN ('pending', 'running') LIMIT 1`,
        [input.dedupeKey ?? null],
      );
      const found = existing.rows[0];
      if (found) return toJob(found);
    }
    throw new Error('enqueue: no se pudo crear ni recuperar el trabajo');
  }

  async claim(now: Instant, limit: number, leaseMs: number): Promise<Job[]> {
    const res = await this.db.query<Row>(
      `WITH picked AS (
         SELECT id FROM jobs
         WHERE status = 'pending' AND run_at <= $1
         ORDER BY (type = ANY($4::text[])), run_at, created_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs j
       SET status = 'running', attempts = j.attempts + 1, lease_until = $3, updated_at = $1
       FROM picked
       WHERE j.id = picked.id
       RETURNING j.*`,
      [ts(now), limit, ts(instantOf(now + leaseMs)), PERIODIC_JOB_TYPES],
    );
    return res.rows.map(toJob);
  }

  async complete(id: string, now: Instant): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'succeeded', lease_until = NULL, completed_at = $2, updated_at = $2
       WHERE id = $1 AND status = 'running'`,
      [id, ts(now)],
    );
  }

  async reschedule(id: string, runAt: Instant, lastError: string, now: Instant): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'pending', run_at = $2, lease_until = NULL, last_error = $3, updated_at = $4
       WHERE id = $1 AND status = 'running'`,
      [id, ts(runAt), lastError, ts(now)],
    );
  }

  async fail(id: string, lastError: string, now: Instant): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'failed', lease_until = NULL, last_error = $2, completed_at = $3, updated_at = $3
       WHERE id = $1 AND status = 'running'`,
      [id, lastError, ts(now)],
    );
  }

  /**
   * Toma los trabajos con bloqueo vencido renovando su bloqueo en la misma sentencia, de modo
   * que solo un ejecutor los recupera (evita auditar o notificar dos veces).
   */
  async takeExpired(now: Instant, limit: number, leaseMs: number): Promise<Job[]> {
    const res = await this.db.query<Row>(
      `WITH expired AS (
         SELECT id FROM jobs
         WHERE status = 'running' AND lease_until <= $1
         ORDER BY lease_until
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs j
       SET lease_until = $3, updated_at = $1
       FROM expired
       WHERE j.id = expired.id
       RETURNING j.*`,
      [ts(now), limit, ts(instantOf(now + leaseMs))],
    );
    return res.rows.map(toJob);
  }
}
