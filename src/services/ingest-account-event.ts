import type { ConnectEvent, PayoutProvider } from '@/modules/accounts/application/ports';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { Logger } from '@/modules/platform/application/ports';

/** Carga minima y sin datos personales que se guarda del evento (BR-J9). */
export type AccountEventPayload = {
  readonly providerAccountId: string;
  readonly occurredAt: number;
};

export const toPayload = (event: ConnectEvent): AccountEventPayload => ({
  providerAccountId: event.providerAccountId,
  occurredAt: event.occurredAt,
});

/** Lectura defensiva del payload guardado (viene de la base de datos). */
export const parsePayload = (raw: unknown): AccountEventPayload | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.providerAccountId !== 'string' || p.providerAccountId === '') return undefined;
  if (typeof p.occurredAt !== 'number' || !Number.isFinite(p.occurredAt)) return undefined;
  return { providerAccountId: p.providerAccountId, occurredAt: p.occurredAt };
};

/** Almacen de eventos entrantes (tabla `webhook_events` de U1). */
export interface WebhookEventStore {
  /** Devuelve verdadero si el evento era nuevo (idempotencia por proveedor y evento). */
  insertIfNew(
    provider: 'stripe' | 'packlink',
    eventId: string,
    eventType: string,
    payload: object,
  ): Promise<boolean>;
}

export type JobEnqueuer = (input: {
  type: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
}) => Promise<unknown>;

export const JOB_APPLY_ACCOUNT_EVENT = 'apply_account_event';

export type IngestResult = 'accepted' | 'duplicate' | 'ignored' | 'invalid_signature';

/**
 * P2-WH-1: verificar la firma sobre el cuerpo crudo, guardar el evento, encolar el trabajo y
 * confirmar. El procesado real ocurre en el trabajo.
 */
export class IngestAccountEvent {
  constructor(
    private readonly deps: {
      readonly provider: Pick<PayoutProvider, 'parseEvent'>;
      readonly store: WebhookEventStore;
      readonly enqueue: JobEnqueuer;
      readonly audit: AuditLog;
      readonly logger: Logger;
    },
  ) {}

  async handle(rawBody: string, signature: string, correlationId: string): Promise<IngestResult> {
    const parsed = this.deps.provider.parseEvent(rawBody, signature);
    if (!parsed.ok) {
      await this.deps.audit.record({
        actorType: 'anonymous',
        action: 'webhook_signature_invalid',
        resourceType: 'webhook',
        resourceId: 'stripe-connect',
        outcome: 'denied',
        correlationId,
      });
      return 'invalid_signature';
    }
    // Evento de un tipo que no usamos: se confirma sin guardarlo.
    if (parsed.value === null) return 'ignored';

    const event = parsed.value;
    const isNew = await this.deps.store.insertIfNew(
      'stripe',
      event.id,
      event.type,
      toPayload(event),
    );
    if (!isNew) return 'duplicate';

    await this.deps.enqueue({
      type: JOB_APPLY_ACCOUNT_EVENT,
      payload: { eventId: event.id, ...toPayload(event) },
      dedupeKey: `account-event:${event.id}`,
    });
    this.deps.logger.info('account_event_accepted', { eventType: event.type, correlationId });
    return 'accepted';
  }
}
