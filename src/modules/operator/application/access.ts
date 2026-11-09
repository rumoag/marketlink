import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { Email } from '@/modules/kernel/domain/formats';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { AuthPort } from '@/modules/accounts/application/ports';
import type { OperatorAlerts } from '@/modules/orders/application/ports';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { Logger } from '@/modules/platform/application/ports';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import {
  enforceLimit,
  systemScope,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import { verifyTotp } from '../domain/totp';
import type { JobSink, OperatorRepos } from './ports';

/** Operadores autorizados y sus secretos TOTP (la configuración los entrega ya validados). */
export interface OperatorDirectory {
  isAuthorized(email: string): boolean;
  /** Secreto TOTP en Base32 del operador; solo se pide en el instante de verificar. */
  totpSecret(email: string): string | undefined;
  all(): readonly string[];
}

export const JOB_SEND_OPERATOR_LINK = 'send_operator_link';
export const JOB_OPERATOR_NOTICE = 'operator_notice';

export const MAX_TOTP_FAILURES = 5;
export const TOTP_WINDOW_MS = 15 * 60_000;
export const TOTP_LOCK_MS = 15 * 60_000;

export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

type Runner = TransactionRunner<OperatorRepos>;

export type AccessDeps = {
  readonly auth: Pick<AuthPort, 'requestMagicLink' | 'verifySignIn'>;
  readonly directory: OperatorDirectory;
  readonly runner: Runner;
  readonly limiter: Pick<RateLimiter, 'check'>;
  readonly audit: AuditLog;
  readonly alerts: OperatorAlerts;
  readonly enqueue: JobSink;
  readonly clock: Clock;
  readonly logger: Logger;
};

/**
 * BR6-AC1: pedir el enlace responde siempre lo mismo y hace siempre el mismo trabajo (límite →
 * encolar → respuesta). Solo el trabajo sabe si el email está autorizado; el tiempo de la
 * petición no depende de la lista.
 */
export class RequestOperatorLink {
  constructor(private readonly deps: AccessDeps) {}

  async execute(
    rawEmail: string,
    clientIp: string,
    correlationId: string,
  ): Promise<Result<void, AppError>> {
    const { deps } = this;
    const limited = await enforceLimit(deps.limiter, 'operator_link_ip', clientIp, {
      failClosed: true,
      correlationId,
    });
    if (!limited.ok) return limited;
    const email = normalizeEmail(rawEmail);
    const valid = Email.parse(email).ok;
    const authorized = valid && deps.directory.isAuthorized(email);
    const minute = Math.floor(deps.clock.now() / 60_000);
    await deps.enqueue({
      type: JOB_SEND_OPERATOR_LINK,
      // Los emails no autorizados nunca se guardan: el trabajo recibe `null`.
      payload: { email: authorized ? email : null },
      dedupeKey: `operator-link:${authorized ? email : 'x'}:${minute}`,
    });
    return ok(undefined);
  }
}

/** Trabajo: si el email está autorizado, pide el enlace al proveedor de acceso. */
export class SendOperatorLink {
  constructor(private readonly deps: AccessDeps) {}

  async execute(email: unknown, correlationId: string): Promise<Result<void, AppError>> {
    const { deps } = this;
    if (typeof email !== 'string' || !deps.directory.isAuthorized(email)) return ok(undefined);
    const parsed = Email.parse(email);
    if (!parsed.ok) return ok(undefined);
    const sent = await deps.auth.requestMagicLink(parsed.value, {
      redirectPath: '/operador/acceso/confirmar',
    });
    if (!sent.ok) {
      deps.logger.error('operator_link_send_failed', { code: sent.error.code, correlationId });
      return err(sent.error);
    }
    return ok(undefined);
  }
}

/**
 * Confirma el enlace: se usa solo para obtener el email verificado y la sesión del proveedor se
 * descarta (nunca se crea una sesión de artista, ni se toca ninguna fila de artista).
 */
export class ConfirmOperatorLink {
  constructor(private readonly deps: AccessDeps) {}

  async execute(
    tokenHash: string,
    correlationId: string,
  ): Promise<Result<{ email: string }, AppError>> {
    const { deps } = this;
    const verified = await deps.auth.verifySignIn(tokenHash);
    const email = verified.ok ? normalizeEmail(verified.value.email) : undefined;
    if (!email || !deps.directory.isAuthorized(email)) {
      await deps.audit.record({
        actorType: 'anonymous',
        action: 'auth_failure',
        resourceType: 'operator_link',
        outcome: 'denied',
        correlationId,
      });
      return err(
        !verified.ok && verified.error.code === 'dependency_unavailable'
          ? appError('dependency_unavailable')
          : appError('unauthenticated'),
      );
    }
    return ok({ email });
  }
}

export type TotpError = 'locked' | 'invalid' | 'unauthorized';

/**
 * BR6-AC2 a AC4: verifica el código TOTP. Un código no se reutiliza (el paso se fija de forma
 * atómica), 5 fallos en 15 minutos bloquean 15 minutos con aviso, y el bloqueo falla cerrado.
 */
export class VerifyOperatorTotp {
  constructor(private readonly deps: AccessDeps) {}

  async execute(input: {
    readonly email: string;
    readonly code: string;
    readonly purpose: 'login' | 'money';
    readonly correlationId: string;
  }): Promise<Result<void, TotpError>> {
    const { deps } = this;
    const email = normalizeEmail(input.email);
    const secret = deps.directory.isAuthorized(email)
      ? deps.directory.totpSecret(email)
      : undefined;
    if (!secret) return err('unauthorized');

    const now = deps.clock.now();
    let state;
    try {
      state = await deps.runner.run(systemScope, (r) => r.operator.getTotpState(email));
    } catch {
      return err('locked'); // fallo cerrado
    }
    if (state?.lockedUntil !== undefined && state.lockedUntil > now) return err('locked');

    const verdict = verifyTotp(secret, input.code.trim(), now, state?.lastStep ?? 0);
    let accepted = false;
    if (verdict.ok) {
      accepted = await deps.runner.run(systemScope, (r) =>
        r.operator.acceptStep(email, verdict.step, now),
      );
    }
    if (!accepted) return this.fail(email, input.correlationId, now);

    await deps.runner.run(systemScope, (r) => r.operator.resetFailures(email, now));
    if (input.purpose === 'login') {
      await deps.audit.record({
        actorType: 'operator',
        actorId: email,
        action: 'operator_login',
        resourceType: 'operator',
        outcome: 'success',
        correlationId: input.correlationId,
      });
      await deps.enqueue({
        type: JOB_OPERATOR_NOTICE,
        payload: { kind: 'acceso', email, at: now },
        dedupeKey: `operator-notice:acceso:${email}:${Math.floor(now / 60_000)}`,
      });
    }
    return ok(undefined);
  }

  private async fail(
    email: string,
    correlationId: string,
    now: number,
  ): Promise<Result<void, TotpError>> {
    const { deps } = this;
    let state;
    try {
      state = await deps.runner.run(systemScope, (r) =>
        r.operator.recordFailure(email, now, TOTP_WINDOW_MS, MAX_TOTP_FAILURES, TOTP_LOCK_MS),
      );
    } catch {
      return err('locked');
    }
    await deps.audit.record({
      actorType: 'operator',
      actorId: email,
      action: 'mfa_failure',
      resourceType: 'operator',
      outcome: 'failure',
      correlationId,
    });
    if (state.lockedUntil !== undefined && state.lockedUntil > now) {
      await deps.audit.record({
        actorType: 'operator',
        actorId: email,
        action: 'operator_locked',
        resourceType: 'operator',
        outcome: 'denied',
        correlationId,
      });
      await deps.alerts.raise('acceso_operador_bloqueado', {}, correlationId);
      await deps.enqueue({
        type: JOB_OPERATOR_NOTICE,
        payload: { kind: 'bloqueo', email, at: now },
        dedupeKey: `operator-notice:bloqueo:${email}:${Math.floor(now / TOTP_LOCK_MS)}`,
      });
      return err('locked');
    }
    return err('invalid');
  }
}
