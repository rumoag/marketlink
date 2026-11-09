import type { Clock } from '@/modules/kernel/domain/clock';
import type { Session, SessionResolver } from '@/modules/platform/application/ports';
import type { OperatorDirectory } from '../application/access';
import {
  ABSOLUTE_MS,
  OPERATOR_COOKIE,
  clearCookieHeader,
  cookieHeader,
  decodeSession,
  encodeSession,
  readCookie,
  touch,
  type OperatorSession,
  type OperatorStage,
  type SessionVerdict,
} from '../domain/operator-session';

/** La actividad se renueva como mucho una vez cada 5 minutos para no reescribir la cookie siempre. */
const RENEW_AFTER_MS = 5 * 60_000;

export type OperatorSessionsOptions = {
  readonly secret: string;
  readonly directory: OperatorDirectory;
  readonly clock: Clock;
  readonly secure: boolean;
};

/**
 * Sesión de operador (BR6-AC5/AC6): cookie propia firmada, revalidada en cada petición contra
 * la lista de emails autorizados. Solo la etapa `completa` da acceso al panel.
 */
export class OperatorSessions implements SessionResolver {
  constructor(private readonly options: OperatorSessionsOptions) {}

  /** Cookie nueva para el email en la etapa indicada. */
  issue(email: string, stage: OperatorStage, createdAt?: number): string {
    const now = this.options.clock.now();
    const session: OperatorSession = {
      email,
      createdAt: createdAt ?? now,
      lastActivityAt: now,
      stage,
    };
    return cookieHeader(
      encodeSession(this.options.secret, session),
      this.options.secure,
      Math.floor(ABSOLUTE_MS / 1000),
    );
  }

  /** Valor y duración de la cookie, para fijarla con la API de cookies de Next.js. */
  issueValue(
    email: string,
    stage: OperatorStage,
    createdAt?: number,
  ): { readonly value: string; readonly maxAge: number; readonly secure: boolean } {
    const now = this.options.clock.now();
    return {
      value: encodeSession(this.options.secret, {
        email,
        createdAt: createdAt ?? now,
        lastActivityAt: now,
        stage,
      }),
      maxAge: Math.floor(ABSOLUTE_MS / 1000),
      secure: this.options.secure,
    };
  }

  clear(): string {
    return clearCookieHeader(this.options.secure);
  }

  read(cookieHeaderValue: string | null | undefined): SessionVerdict {
    return decodeSession(
      this.options.secret,
      readCookie(cookieHeaderValue ?? null, OPERATOR_COOKIE),
      this.options.clock.now(),
    );
  }

  /** Sesión pendiente de segundo factor (para la página del código). */
  pending(cookieHeaderValue: string | null | undefined): OperatorSession | undefined {
    const v = this.read(cookieHeaderValue);
    return v.ok &&
      v.session.stage === 'pendiente_mfa' &&
      this.options.directory.isAuthorized(v.session.email)
      ? v.session
      : undefined;
  }

  resolve(headers: Headers): Promise<Session | null> {
    const v = this.read(headers.get('cookie'));
    if (!v.ok) return Promise.resolve(null);
    const { session } = v;
    if (session.stage !== 'completa') return Promise.resolve(null);
    // Quitar un email de la lista cierra la sesión en la siguiente petición.
    if (!this.options.directory.isAuthorized(session.email)) return Promise.resolve(null);
    const now = this.options.clock.now();
    const renewed =
      now - session.lastActivityAt > RENEW_AFTER_MS
        ? [
            cookieHeader(
              encodeSession(this.options.secret, touch(session, now)),
              this.options.secure,
              Math.floor(ABSOLUTE_MS / 1000),
            ),
          ]
        : [];
    return Promise.resolve({
      userId: session.email,
      role: 'operator',
      setCookies: renewed,
    });
  }
}
