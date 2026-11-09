import type { Clock } from '@/modules/kernel/domain/clock';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { Logger } from '@/modules/platform/application/ports';
import type { Secret } from '@/modules/platform/application/config';
import { secretMatches } from '@/modules/platform/infrastructure/secrets';
import { reduceProviderEvent } from '@/modules/shipping/domain/provider-events';
import { FACT_TYPES, type ShipmentFact } from '@/modules/shipping/domain/shipment';
import { instantOf } from '@/modules/kernel/domain/clock';
import type { IngestResult, JobEnqueuer, WebhookEventStore } from './ingest-account-event';

export const JOB_CREATE_SHIPMENT_DRAFT = 'create_shipment_draft';
export const JOB_PROCESS_SHIPMENT_FACT = 'process_shipment_fact';
export const JOB_POLL_SHIPMENTS = 'poll_shipments';
export const JOB_DISPATCH_NOTIFICATIONS = 'dispatch_notifications';
export const JOB_REMIND_PICKUP = 'remind_pickup';
export const JOB_REMIND_PAY_LABEL = 'remind_pay_label';
export const JOB_PURGE_LABELS = 'purge_labels_and_notifications';

/** Lectura defensiva del hecho guardado en el trabajo (viene de la base de datos). */
export const parseFact = (raw: unknown): ShipmentFact | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const f = raw as Record<string, unknown>;
  if (typeof f.type !== 'string' || !(FACT_TYPES as readonly string[]).includes(f.type))
    return undefined;
  if (typeof f.at !== 'number' || !Number.isFinite(f.at)) return undefined;
  return {
    type: f.type as ShipmentFact['type'],
    at: instantOf(f.at),
    trackingUrl: typeof f.trackingUrl === 'string' ? f.trackingUrl : undefined,
    trackingCode: typeof f.trackingCode === 'string' ? f.trackingCode : undefined,
    labelCostCents: typeof f.labelCostCents === 'number' ? f.labelCostCents : undefined,
  };
};

export type IngestShipmentDeps = {
  readonly secret: Secret | undefined;
  readonly store: WebhookEventStore;
  readonly enqueue: JobEnqueuer;
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly clock: Clock;
};

/**
 * Webhook de Packlink (BR4-EV1): secreto en tiempo constante, evento reducido a un hecho, guardado
 * idempotente, trabajo y confirmacion. Referencias o eventos desconocidos se confirman sin efecto.
 */
export class IngestShipmentEvent {
  constructor(private readonly deps: IngestShipmentDeps) {}

  async handle(
    rawBody: string,
    suppliedSecret: string | null,
    correlationId: string,
  ): Promise<IngestResult> {
    if (!secretMatches(suppliedSecret, this.deps.secret)) {
      await this.deps.audit.record({
        actorType: 'anonymous',
        action: 'webhook_signature_invalid',
        resourceType: 'webhook',
        resourceId: 'packlink',
        outcome: 'denied',
        correlationId,
      });
      return 'invalid_signature';
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return 'ignored';
    }
    const event = reduceProviderEvent(body, this.deps.clock.now());
    if (!event) return 'ignored';

    const payload = { providerRef: event.providerRef, fact: event.fact };
    const isNew = await this.deps.store.insertIfNew(
      'packlink',
      event.eventId,
      event.fact.type,
      payload,
    );
    if (!isNew) return 'duplicate';
    await this.deps.enqueue({
      type: JOB_PROCESS_SHIPMENT_FACT,
      payload: { eventId: event.eventId, ...payload },
      dedupeKey: `shipment-event:${event.eventId}`,
    });
    this.deps.logger.info('shipment_event_accepted', { type: event.fact.type, correlationId });
    return 'accepted';
  }
}
