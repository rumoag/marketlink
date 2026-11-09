import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { Email } from '@/modules/kernel/domain/formats';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { Logger } from '@/modules/platform/application/ports';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import {
  enforceLimit,
  systemScope,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import type { Artist } from '../domain/artist';
import type { AccountsRepos, AuthPort, AuthSession } from './ports';

export type SignInDeps = {
  readonly auth: AuthPort;
  readonly runner: TransactionRunner<AccountsRepos>;
  readonly limiter: Pick<RateLimiter, 'check'>;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly logger: Logger;
};

export type SignedIn = { readonly artist: Artist; readonly session: AuthSession };

/** US-001: acceso sin contrasena. */
export class SignInService {
  constructor(private readonly deps: SignInDeps) {}

  /**
   * BR2-AC2/AC3: la respuesta es la misma exista o no la cuenta y aunque el correo falle.
   * Solo un email mal formado o un limite superado se notifican (no revelan nada de la cuenta).
   */
  async requestMagicLink(
    rawEmail: string,
    clientIp: string,
    correlationId: string,
  ): Promise<Result<void, AppError>> {
    const parsed = Email.parse(rawEmail);
    if (!parsed.ok) {
      return err(appError('validation', { details: [{ field: 'email', reason: 'invalido' }] }));
    }
    const email = parsed.value;

    // Fallo cerrado: si el almacen de contadores falla no se envian enlaces (BR-L4).
    const byEmail = await enforceLimit(this.deps.limiter, 'magic_link_email', email, {
      failClosed: true,
      correlationId,
    });
    if (!byEmail.ok) return byEmail;
    const byIp = await enforceLimit(this.deps.limiter, 'magic_link_ip', clientIp, {
      failClosed: true,
      correlationId,
    });
    if (!byIp.ok) return byIp;

    const sent = await this.deps.auth.requestMagicLink(email);
    if (!sent.ok) {
      // U2-NFR-AV3: el usuario recibe el mismo mensaje; el fallo se registra sin datos personales.
      this.deps.logger.error('magic_link_send_failed', {
        code: sent.error.code,
        correlationId,
      });
    }
    return ok(undefined);
  }

  /** BR2-AC4 a AC6: consume el enlace; cualquier fallo es un mensaje generico mas AuditEvent. */
  async completeSignIn(
    tokenHash: string,
    correlationId: string,
  ): Promise<Result<SignedIn, AppError>> {
    const verified = await this.deps.auth.verifySignIn(tokenHash);
    if (!verified.ok) {
      await this.deps.audit.record({
        actorType: 'anonymous',
        action: 'auth_failure',
        resourceType: 'magic_link',
        outcome: 'denied',
        correlationId,
      });
      // Una caida del proveedor se distingue del enlace invalido solo para poder reintentar.
      return err(
        verified.error.code === 'dependency_unavailable'
          ? appError('dependency_unavailable')
          : appError('unauthenticated'),
      );
    }

    const { userId, email } = verified.value;
    const artist = await this.deps.runner.run(systemScope, (repos) =>
      repos.artists.upsertOnSignIn(userId, email, this.deps.clock.now()),
    );
    return ok({ artist, session: verified.value });
  }

  /** BR2-AC8: revoca la sesion en el proveedor; las cookies las borra la capa web. */
  async signOut(accessToken: string): Promise<void> {
    try {
      await this.deps.auth.signOut(accessToken);
    } catch {
      this.deps.logger.warn('sign_out_failed');
    }
  }
}
