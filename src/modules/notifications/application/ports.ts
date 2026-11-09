import type { AppError } from '@/modules/kernel/domain/app-error';
import type { Instant } from '@/modules/kernel/domain/clock';
import type { Result } from '@/modules/kernel/domain/result';
import type { EmailContext, Notification, RecipientRole } from '../domain/notification';

export interface NotificationRepository {
  /** Inserta las que no existan (unico por pedido y tipo): repetir no duplica. Devuelve cuantas eran nuevas. */
  insertMany(notifications: readonly Notification[]): Promise<number>;
  /**
   * Toma hasta `limit` pendientes vencidas y las reserva `leaseMs` moviendo `nextAttemptAt`
   * (exclusivo entre ejecutores).
   */
  claimDue(now: Instant, limit: number, leaseMs: number): Promise<Notification[]>;
  markSent(id: string, now: Instant): Promise<void>;
  reschedule(id: string, attempts: number, nextAttemptAt: Instant, error: string): Promise<void>;
  markFailed(id: string, attempts: number, error: string): Promise<void>;
  listFailedByArtist(artistId: string): Promise<Notification[]>;
  /** Borra las de mas de `before` (retencion); devuelve cuantas. */
  deleteOlderThan(before: Instant): Promise<number>;
}

export type EmailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly idempotencyKey: string;
};

/** Envio de correo. `dependency_unavailable` es reintentable; cualquier otro error es permanente. */
export interface EmailSender {
  send(message: EmailMessage): Promise<Result<void, AppError>>;
}

/** Destinatario y contexto de una notificacion, resueltos solo en el momento de enviar. */
export interface NotificationContextLoader {
  load(
    orderId: string,
    role: RecipientRole,
  ): Promise<{ readonly to: string; readonly context: EmailContext } | undefined>;
  /** Aviso sin pedido (retirada): destinatario y contexto de la artista. */
  loadForArtist(
    artistId: string,
    amountCents: number | undefined,
  ): Promise<{ readonly to: string; readonly context: EmailContext } | undefined>;
}
