import { instantOf, type Instant } from '@/modules/kernel/domain/clock';
import type { JobStore } from '@/modules/jobs/application/job-queue';
import { isTerminal, type Job, type NewJob } from '@/modules/jobs/domain/job';

/** Doble en memoria con la misma semantica que PgJobStore (mismas reglas, sin SQL). */
export class MemoryJobStore implements JobStore {
  readonly jobs = new Map<string, Job>();
  private seq = 0;

  enqueue(input: NewJob, now: Instant): Promise<Job> {
    if (input.dedupeKey !== undefined) {
      for (const j of this.jobs.values()) {
        if (j.dedupeKey === input.dedupeKey && !isTerminal(j.status)) return Promise.resolve(j);
      }
    }
    this.seq += 1;
    const job: Job = {
      id: `job-${this.seq}`,
      type: input.type,
      payload: input.payload ?? {},
      dedupeKey: input.dedupeKey,
      status: 'pending',
      attempts: 0,
      runAt: input.runAt ?? now,
      leaseUntil: undefined,
      lastError: undefined,
      createdAt: now,
      updatedAt: now,
      completedAt: undefined,
    };
    this.jobs.set(job.id, job);
    return Promise.resolve(job);
  }

  claim(now: Instant, limit: number, leaseMs: number): Promise<Job[]> {
    const ready = [...this.jobs.values()]
      .filter((j) => j.status === 'pending' && j.runAt <= now)
      .sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt)
      .slice(0, limit);
    const claimed = ready.map((j): Job => {
      const next: Job = {
        ...j,
        status: 'running',
        attempts: j.attempts + 1,
        leaseUntil: instantOf(now + leaseMs),
        updatedAt: now,
      };
      this.jobs.set(j.id, next);
      return next;
    });
    return Promise.resolve(claimed);
  }

  private update(id: string, patch: Partial<Job>): void {
    const current = this.jobs.get(id);
    // Igual que el SQL: solo se resuelve un trabajo que sigue en running.
    if (current?.status === 'running') this.jobs.set(id, { ...current, ...patch });
  }

  complete(id: string, now: Instant): Promise<void> {
    this.update(id, {
      status: 'succeeded',
      leaseUntil: undefined,
      completedAt: now,
      updatedAt: now,
    });
    return Promise.resolve();
  }

  reschedule(id: string, runAt: Instant, lastError: string, now: Instant): Promise<void> {
    this.update(id, { status: 'pending', runAt, leaseUntil: undefined, lastError, updatedAt: now });
    return Promise.resolve();
  }

  fail(id: string, lastError: string, now: Instant): Promise<void> {
    this.update(id, {
      status: 'failed',
      leaseUntil: undefined,
      lastError,
      completedAt: now,
      updatedAt: now,
    });
    return Promise.resolve();
  }

  takeExpired(now: Instant, limit: number, leaseMs: number): Promise<Job[]> {
    const expired = [...this.jobs.values()]
      .filter((j) => j.status === 'running' && j.leaseUntil !== undefined && j.leaseUntil <= now)
      .sort((a, b) => (a.leaseUntil ?? 0) - (b.leaseUntil ?? 0))
      .slice(0, limit)
      .map((j): Job => {
        const next: Job = { ...j, leaseUntil: instantOf(now + leaseMs), updatedAt: now };
        this.jobs.set(j.id, next);
        return next;
      });
    return Promise.resolve(expired);
  }
}
