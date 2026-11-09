import { addMs, MS, type Clock } from '@/modules/kernel/domain/clock';
import type { Logger } from '@/modules/platform/application/ports';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import {
  MAX_NOTIFICATION_ATTEMPTS,
  notificationBackoffMs,
  renderEmail,
  type Notification,
} from '../domain/notification';
import type { EmailSender, NotificationContextLoader, NotificationRepository } from './ports';

const BATCH = 20;
const LEASE_MS = 5 * MS.minute;

export type DispatchDeps = {
  readonly runner: TransactionRunner<{ readonly notifications: NotificationRepository }>;
  readonly sender: EmailSender;
  readonly loader: NotificationContextLoader;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Se llama cuando una notificacion queda `fallida` (aviso al operador). */
  readonly onFailed: (notification: Notification, correlationId: string) => Promise<void>;
};

/**
 * Bandeja de salida (Q1 A): envia las notificaciones pendientes con reintentos y retroceso.
 * Nada se pierde: lo guardado con el cambio de estado se reintenta hasta enviarse o fallar.
 */
export class DispatchNotifications {
  constructor(private readonly deps: DispatchDeps) {}

  async execute(correlationId: string): Promise<{ sent: number; retried: number; failed: number }> {
    const { deps } = this;
    const now = deps.clock.now();
    const claimed = await deps.runner.run(systemScope, (repos) =>
      repos.notifications.claimDue(now, BATCH, LEASE_MS),
    );
    let sent = 0;
    let retried = 0;
    let failed = 0;

    for (const n of claimed) {
      const attempts = n.attempts + 1;
      const target =
        n.orderId !== undefined
          ? await deps.loader.load(n.orderId, n.recipientRole)
          : await deps.loader.loadForArtist(n.artistId, n.amountCents);
      if (!target) {
        await deps.runner.run(systemScope, (repos) =>
          repos.notifications.markFailed(n.id, attempts, 'sin_destinatario'),
        );
        failed += 1;
        await deps.onFailed(n, correlationId);
        continue;
      }
      const mail = renderEmail(n.type, target.context);
      const res = await deps.sender.send({
        to: target.to,
        subject: mail.subject,
        text: mail.text,
        idempotencyKey: `notif:${n.id}`,
      });
      if (res.ok) {
        await deps.runner.run(systemScope, (repos) =>
          repos.notifications.markSent(n.id, deps.clock.now()),
        );
        sent += 1;
        continue;
      }
      const retryable =
        res.error.code === 'dependency_unavailable' || res.error.code === 'rate_limited';
      if (retryable && attempts < MAX_NOTIFICATION_ATTEMPTS) {
        await deps.runner.run(systemScope, (repos) =>
          repos.notifications.reschedule(
            n.id,
            attempts,
            addMs(deps.clock.now(), notificationBackoffMs(attempts)),
            res.error.code,
          ),
        );
        retried += 1;
        continue;
      }
      await deps.runner.run(systemScope, (repos) =>
        repos.notifications.markFailed(
          n.id,
          attempts,
          retryable ? 'agotados_intentos' : res.error.code,
        ),
      );
      failed += 1;
      deps.logger.warn('notification_failed', { correlationId, type: n.type });
      await deps.onFailed(n, correlationId);
    }
    return { sent, retried, failed };
  }
}
