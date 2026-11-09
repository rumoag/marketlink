import type { LogFields, Logger } from '@/modules/platform/application/ports';
import type { AuditEvent, AuditStore } from '@/modules/platform/application/audit-log';
import type { CounterStore } from '@/modules/platform/application/rate-limiter';

export type LogEntry = {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields;
};

/** Logger en memoria para comprobar que se registra (y que no se filtran secretos). */
export class MemoryLogger implements Logger {
  readonly entries: LogEntry[] = [];
  constructor(private readonly bindings: LogFields = {}) {}

  private push(level: LogEntry['level'], message: string, fields?: LogFields): void {
    this.entries.push({ level, message, fields: { ...this.bindings, ...(fields ?? {}) } });
  }
  debug(m: string, f?: LogFields): void {
    this.push('debug', m, f);
  }
  info(m: string, f?: LogFields): void {
    this.push('info', m, f);
  }
  warn(m: string, f?: LogFields): void {
    this.push('warn', m, f);
  }
  error(m: string, f?: LogFields): void {
    this.push('error', m, f);
  }
  child(bindings: LogFields): Logger {
    const child = new MemoryLogger({ ...this.bindings, ...bindings });
    // Comparte el almacen de entradas con el padre.
    (child as { entries: LogEntry[] }).entries = this.entries;
    return child;
  }
}

export class MemoryAuditStore implements AuditStore {
  readonly events: AuditEvent[] = [];
  failWith: Error | undefined;
  append(event: AuditEvent): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.events.push(event);
    return Promise.resolve();
  }
}

/** Contador atomico en memoria con la misma semantica que la tabla de Postgres. */
export class MemoryCounterStore implements CounterStore {
  private readonly counts = new Map<string, number>();
  failWith: Error | undefined;

  increment(rule: string, subjectHash: string, windowStartSeconds: number): Promise<number> {
    if (this.failWith) return Promise.reject(this.failWith);
    const key = `${rule}|${subjectHash}|${windowStartSeconds}`;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return Promise.resolve(next);
  }
}
