import type { Instant } from '@/modules/kernel/domain/clock';
import type { Db } from '@/modules/platform/infrastructure/db-client';
import type { ProviderCache } from '../application/ports';

/**
 * Cache compartida en Postgres con caducidad (ADR 0033). Sin datos personales: servicios y puntos
 * publicos de Packlink. La lectura filtra por `expires_at > now`: una entrada caducada no se usa nunca.
 */
export class PgProviderCache implements ProviderCache {
  constructor(private readonly db: Db) {}

  async get(key: string, now: Instant): Promise<unknown> {
    const res = await this.db.query<{ payload: unknown }>(
      'SELECT payload FROM provider_cache WHERE key = $1 AND expires_at > $2',
      [key, new Date(now)],
    );
    return res.rows[0]?.payload;
  }

  async set(key: string, value: unknown, ttlMs: number, now: Instant): Promise<void> {
    await this.db.query(
      `INSERT INTO provider_cache (key, payload, expires_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(value), new Date(now + ttlMs)],
    );
    // Limpieza oportunista de caducadas (NFR-U8-11); la purga diaria cubre el resto.
    await this.db.query('DELETE FROM provider_cache WHERE expires_at < $1', [
      new Date(now - 3_600_000),
    ]);
  }
}
