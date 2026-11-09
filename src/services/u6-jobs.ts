import type { JobHandlerRegistry } from '@/modules/jobs/application/job-queue';
import type { EmailSender } from '@/modules/notifications/application/ports';
import {
  JOB_OPERATOR_NOTICE,
  JOB_SEND_OPERATOR_LINK,
  type OperatorDirectory,
  type SendOperatorLink,
} from '@/modules/operator/application/access';
import type { OperatorRepository } from '@/modules/operator/application/ports';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import type { Clock } from '@/modules/kernel/domain/clock';

export const JOB_PURGE_LISTING_VIEWS = 'purge_listing_views';

/** Conservación del contador de visitas: 24 meses (NFR-U6-14). */
const VIEWS_RETENTION_DAYS = 730;

export type U6JobDeps = {
  readonly sendLink: Pick<SendOperatorLink, 'execute'>;
  readonly directory: OperatorDirectory;
  readonly email: EmailSender;
  readonly appName: string;
  readonly runner: TransactionRunner<{ readonly operator: OperatorRepository }>;
  readonly clock: Clock;
};

const when = (at: number): string =>
  new Date(at).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    dateStyle: 'long',
    timeStyle: 'short',
  });

/** Registra los trabajos de U6. Todos son idempotentes. */
export const registerU6Jobs = (registry: JobHandlerRegistry, deps: U6JobDeps): void => {
  registry.register(JOB_SEND_OPERATOR_LINK, async (job, ctx) => {
    const r = await deps.sendLink.execute(job.payload.email, ctx.correlationId);
    return r.ok
      ? { ok: true }
      : { ok: false, error: { retryable: true, message: 'send_operator_link_failed' } };
  });

  // Aviso de acceso (al propio operador) o de bloqueo (a todos). Sin IP ni datos del dispositivo.
  registry.register(JOB_OPERATOR_NOTICE, async (job) => {
    const kind = job.payload.kind;
    const at = typeof job.payload.at === 'number' ? job.payload.at : deps.clock.now();
    const email = typeof job.payload.email === 'string' ? job.payload.email : undefined;
    if (kind !== 'acceso' && kind !== 'bloqueo' && kind !== 'seguridad') {
      return { ok: false, error: { retryable: false, message: 'invalid_notice_payload' } };
    }
    const to = kind === 'acceso' ? (email ? [email] : []) : [...deps.directory.all()];
    const alertName = typeof job.payload.alert === 'string' ? job.payload.alert : 'seguridad';
    const count = typeof job.payload.count === 'number' ? job.payload.count : 0;
    for (const address of to) {
      if (!deps.directory.isAuthorized(address)) continue;
      const sent = await deps.email.send({
        to: address,
        subject:
          kind === 'seguridad'
            ? `Alerta de seguridad en ${deps.appName}: ${alertName}`
            : kind === 'acceso'
              ? `Acceso al panel de ${deps.appName}`
              : `Acceso al panel de ${deps.appName} bloqueado`,
        text:
          kind === 'seguridad'
            ? `Se han detectado ${count} eventos de tipo «${alertName}» en la última hora (${when(at)}).

Consulta docs/incident-process.md (sección de alertas de seguridad) y revisa la auditoría.`
            : kind === 'acceso'
              ? `Se ha accedido al panel del operador el ${when(at)}.\n\nSi no has sido tú, rota OPERATOR_SESSION_SECRET y tu secreto TOTP (runbook operador-acceso.md).`
              : `Se han superado los intentos del segundo factor y el acceso al panel queda bloqueado 15 minutos (${when(at)}).\n\nSi no has sido tú, rota OPERATOR_SESSION_SECRET y tu secreto TOTP (runbook operador-acceso.md).`,
        idempotencyKey: `operator-notice:${String(kind)}:${address}:${at}`,
      });
      if (!sent.ok) {
        return { ok: false, error: { retryable: true, message: 'operator_notice_failed' } };
      }
    }
    return { ok: true };
  });

  registry.register(JOB_PURGE_LISTING_VIEWS, async () => {
    const cutoff = new Date(deps.clock.now() - VIEWS_RETENTION_DAYS * 24 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    await deps.runner.run(systemScope, (r) => r.operator.purgeViews(cutoff));
    return { ok: true };
  });
};
