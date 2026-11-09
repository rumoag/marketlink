import type { Logger } from './ports';

export type OperatorAlert = {
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly correlationId?: string;
  /** Sin datos personales ni secretos. */
  readonly details?: Readonly<Record<string, unknown>>;
};

/** Aviso al operador. U1 solo registra; U7 anade el envio por email sin cambiar a los llamadores. */
export interface OperatorNotifier {
  notify(alert: OperatorAlert): Promise<void>;
}

export class LoggingOperatorNotifier implements OperatorNotifier {
  constructor(private readonly logger: Logger) {}

  notify(alert: OperatorAlert): Promise<void> {
    const log = alert.severity === 'critical' ? this.logger.error : this.logger.warn;
    log.call(this.logger, 'operator_alert', {
      severity: alert.severity,
      title: alert.title,
      correlationId: alert.correlationId,
      details: alert.details,
    });
    return Promise.resolve();
  }
}
