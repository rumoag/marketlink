import { formatISO } from '@/modules/kernel/domain/dates';
import type { AuditEvent, AuditStore } from '../application/audit-log';
import type { CounterStore } from '../application/rate-limiter';
import type { Db } from './db-client';

/** Contador atomico: una sola sentencia incrementa o crea la fila y devuelve el valor (PF3). */
export class PgCounterStore implements CounterStore {
  constructor(private readonly db: Db) {}

  async increment(rule: string, subjectHash: string, windowStartSeconds: number): Promise<number> {
    const res = await this.db.query<{ count: number }>(
      `INSERT INTO rate_limit_counters (rule, subject_hash, window_start, count)
       VALUES ($1, $2, to_timestamp($3), 1)
       ON CONFLICT (rule, subject_hash, window_start)
       DO UPDATE SET count = rate_limit_counters.count + 1
       RETURNING count`,
      [rule, subjectHash, windowStartSeconds],
    );
    const row = res.rows[0];
    if (!row) throw new Error('increment sin fila');
    return Number(row.count);
  }
}

/** Solo inserta: el rol de la aplicacion no tiene UPDATE ni DELETE sobre audit_events. */
export class PgAuditStore implements AuditStore {
  constructor(private readonly db: Db) {}

  async append(event: AuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_events
         (occurred_at, actor_type, actor_id, action, resource_type, resource_id,
          outcome, correlation_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        formatISO(event.occurredAt),
        event.actorType,
        event.actorId ?? null,
        event.action,
        event.resourceType ?? null,
        event.resourceId ?? null,
        event.outcome,
        event.correlationId,
        JSON.stringify(event.details),
      ],
    );
  }
}
