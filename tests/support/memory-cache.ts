import type { Instant } from '@/modules/kernel/domain/clock';
import type { ProviderCache } from '@/modules/checkout/application/ports';

/** Cache de proveedor en memoria con caducidad (doble de `PgProviderCache`). */
export class InMemoryProviderCache implements ProviderCache {
  readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  failReads = false;
  failWrites = false;
  gets = 0;
  sets = 0;

  get(key: string, now: Instant): Promise<unknown> {
    this.gets += 1;
    if (this.failReads) return Promise.reject(new Error('cache_down'));
    const e = this.entries.get(key);
    return Promise.resolve(e !== undefined && e.expiresAt > now ? e.value : undefined);
  }

  set(key: string, value: unknown, ttlMs: number, now: Instant): Promise<void> {
    this.sets += 1;
    if (this.failWrites) return Promise.reject(new Error('cache_down'));
    this.entries.set(key, { value: JSON.parse(JSON.stringify(value)), expiresAt: now + ttlMs });
    return Promise.resolve();
  }
}
