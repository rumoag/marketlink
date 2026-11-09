import type { Clock } from '@/modules/kernel/domain/clock';
import type { Logger, Session, SessionResolver } from '@/modules/platform/application/ports';
import type { AuthPort } from '../application/ports';
import { isSessionValid, shouldRenewActivity } from '../domain/session';
import {
  accessCookie,
  activityCookie,
  COOKIE_ACCESS,
  COOKIE_ACTIVITY,
  COOKIE_REFRESH,
  decodeActivityCookie,
  parseCookies,
  refreshCookie,
} from './session-cookie';

export type SessionResolverDeps = {
  readonly auth: AuthPort;
  readonly cookieSecret: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Cookies `Secure` (siempre en produccion; solo se desactiva en http local). */
  readonly secureCookies: boolean;
};

/**
 * Implementa `SessionResolver` de U1 (P2-SES-1):
 *  1. La cookie de actividad firmada debe ser valida: 7 dias de inactividad y 30 desde el inicio.
 *  2. El token de acceso se verifica localmente; si caduco, se renueva con el de refresco.
 *  3. La actividad se renueva como mucho cada 5 minutos.
 * Cualquier fallo devuelve `null` (sin sesion); nunca lanza.
 */
export class SessionResolverImpl implements SessionResolver {
  constructor(private readonly deps: SessionResolverDeps) {}

  async resolve(headers: Headers): Promise<Session | null> {
    try {
      const cookies = parseCookies(headers.get('cookie'));
      const times = decodeActivityCookie(cookies[COOKIE_ACTIVITY], this.deps.cookieSecret);
      if (!times) return null;

      const now = this.deps.clock.now();
      if (!isSessionValid(times, now)) return null;

      const setCookies: string[] = [];
      const secure = this.deps.secureCookies;

      const accessToken = cookies[COOKIE_ACCESS];
      let identity = accessToken ? await this.deps.auth.verifyAccessToken(accessToken) : null;

      if (!identity) {
        const refreshToken = cookies[COOKIE_REFRESH];
        if (!refreshToken) return null;
        const refreshed = await this.deps.auth.refresh(refreshToken);
        if (!refreshed.ok) return null;
        identity = { userId: refreshed.value.userId, email: refreshed.value.email };
        setCookies.push(
          accessCookie(refreshed.value.accessToken, secure),
          refreshCookie(refreshed.value.refreshToken, secure),
        );
      }

      if (shouldRenewActivity(times, now)) {
        setCookies.push(
          activityCookie(
            { createdAt: times.createdAt, lastActivityAt: now },
            this.deps.cookieSecret,
            secure,
          ),
        );
      }

      return {
        userId: identity.userId,
        role: 'artist',
        loginAt: times.createdAt,
        ...(setCookies.length > 0 ? { setCookies } : {}),
      };
    } catch {
      this.deps.logger.warn('session_resolve_failed');
      return null;
    }
  }
}
