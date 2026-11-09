import type { Clock, Instant } from '@/modules/kernel/domain/clock';
import { formatISO } from '@/modules/kernel/domain/dates';
import { redact } from '../domain/redactor';
import type { Logger } from './ports';

/** Eventos de seguridad que siempre generan AuditEvent (BR-G5). */
export type AuditAction =
  | 'auth_failure'
  | 'authz_denied'
  | 'rate_limited'
  | 'webhook_signature_invalid'
  | 'mfa_failure'
  | 'job_failed'
  // U3 (NFR-U3-23)
  | 'checkout_created'
  | 'payment_confirmed'
  | 'duplicate_payment'
  | 'refund_requested'
  | 'refund_done'
  | 'refund_failed'
  | 'manual_payment_confirmed'
  | 'operator_alert'
  | 'personal_data_purged'
  | 'reconciliation_mismatch'
  // U4
  | 'label_downloaded'
  | 'invoice_generated'
  | 'shipment_draft_created'
  | 'labels_purged'
  // U5
  | 'settlement_done'
  | 'settlement_blocked'
  | 'withdrawal_requested'
  | 'withdrawal_done'
  | 'withdrawal_failed'
  | 'manual_release'
  | 'ledger_mismatch'
  | 'balance_mismatch'
  | 'finance_exported'
  | 'charge_refunded_external'
  | 'dispute_opened'
  // U6
  | 'operator_login'
  | 'operator_locked'
  | 'operator_view_order'
  | 'operator_retry_draft'
  | 'operator_flag_open'
  | 'operator_flag_close'
  | 'operator_note'
  | 'operator_sizes_changed'
  | 'operator_release'
  | 'operator_refund'
  // U7
  | 'personal_data_erased'
  | 'security_alert';

export type ActorType = 'artist' | 'operator' | 'buyer' | 'system' | 'anonymous';
export type Outcome = 'success' | 'denied' | 'failure';

export type AuditEvent = {
  readonly occurredAt: Instant;
  readonly actorType: ActorType;
  readonly actorId?: string;
  readonly action: AuditAction;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly outcome: Outcome;
  readonly correlationId: string;
  /** JSON saneado: sin PII ni secretos. */
  readonly details: Readonly<Record<string, unknown>>;
};

export type AuditInput = Omit<AuditEvent, 'occurredAt' | 'details'> & {
  readonly details?: Readonly<Record<string, unknown>>;
};

/** Almacen de solo insercion (SECURITY-14): no hay metodos para modificar ni borrar. */
export interface AuditStore {
  append(event: AuditEvent): Promise<void>;
}

export class AuditLog {
  constructor(
    private readonly store: AuditStore,
    private readonly logger: Logger,
    private readonly clock: Clock,
  ) {}

  /**
   * Registra el evento en el almacen y deja una copia en el log (fuera de la base de datos).
   * Un fallo del almacen se registra como error pero no interrumpe la peticion.
   */
  async record(input: AuditInput): Promise<void> {
    const event: AuditEvent = {
      ...input,
      occurredAt: this.clock.now(),
      details: redact(input.details ?? {}) as Record<string, unknown>,
    };
    this.logger.info('audit_event', {
      audit: true,
      action: event.action,
      actorType: event.actorType,
      outcome: event.outcome,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      correlationId: event.correlationId,
      occurredAt: formatISO(event.occurredAt),
    });
    try {
      await this.store.append(event);
    } catch {
      this.logger.error('audit_store_failed', {
        action: event.action,
        correlationId: event.correlationId,
      });
    }
  }
}
