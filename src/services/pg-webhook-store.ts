import type { Db } from '@/modules/platform/infrastructure/db-client';
import type { WebhookEventStore } from './ingest-account-event';

/** Eventos entrantes en `webhook_events` (U1): la restriccion unica da idempotencia. */
export class PgWebhookEventStore implements WebhookEventStore {
  constructor(private readonly db: Pick<Db, 'query'>) {}

  async insertIfNew(
    provider: 'stripe' | 'packlink',
    eventId: string,
    eventType: string,
    payload: object,
  ): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO webhook_events (provider, event_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (provider, event_id) DO NOTHING`,
      [provider, eventId, eventType, JSON.stringify(payload)],
    );
    return res.rowCount === 1;
  }

  async markProcessed(provider: 'stripe' | 'packlink', eventId: string): Promise<void> {
    await this.db.query(
      `UPDATE webhook_events SET status = 'processed', processed_at = now()
        WHERE provider = $1 AND event_id = $2`,
      [provider, eventId],
    );
  }
}
