import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import {
  isOperatorPath,
  maskPathForLogs,
  resolveRoute,
  type RouteTable,
} from '../domain/route-table';
import type { ErrorHandler } from '../application/error-handler';
import type { Logger, SessionResolver } from '../application/ports';
import type { RateLimiter } from '../application/rate-limiter';
import { generateNonce, securityHeaders } from './security-headers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** P-OBS-1: se acepta el ID entrante solo si es un UUID; si no, se genera uno. */
export const resolveCorrelationId = (incoming: string | null): string =>
  incoming !== null && UUID.test(incoming) ? incoming.toLowerCase() : randomUUID();

/** En Vercel, `x-forwarded-for` lo fija la plataforma; se usa el primer elemento. */
export const clientIp = (headers: Headers): string => {
  const forwarded = headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || headers.get('x-real-ip')?.trim() || 'unknown';
};

export type PipelineDeps = {
  readonly table: RouteTable;
  readonly sessions: SessionResolver;
  /** U6: sesion de operador (cookie propia). Sin ella, el panel no existe. */
  readonly operatorSessions?: SessionResolver | undefined;
  readonly limiter: Pick<RateLimiter, 'check'>;
  readonly errors: ErrorHandler;
  readonly logger: Logger;
  readonly isDev: boolean;
  readonly imgSources?: readonly string[];
  readonly connectSources?: readonly string[];
  readonly newNonce?: () => string;
};

/**
 * Proxy de entrada (P-SEG-1 a 3, P-OBS-1): correlacion, nonce y cabeceras, denegar por defecto,
 * guarda de sesion y rol, y limite de tasa. Toda respuesta, tambien las de error, lleva cabeceras.
 */
export const createPipeline = (deps: PipelineDeps) => {
  return async (req: NextRequest): Promise<NextResponse> => {
    const correlationId = resolveCorrelationId(req.headers.get('x-correlation-id'));
    const nonce = (deps.newNonce ?? generateNonce)();
    const sec = securityHeaders({
      nonce,
      isDev: deps.isDev,
      ...(deps.imgSources ? { imgSources: deps.imgSources } : {}),
      ...(deps.connectSources ? { connectSources: deps.connectSources } : {}),
    });

    const decorate = (res: NextResponse): NextResponse => {
      for (const [k, v] of Object.entries(sec)) res.headers.set(k, v);
      res.headers.set('x-correlation-id', correlationId);
      res.headers.set('Cache-Control', 'private, no-store');
      return res;
    };

    const fail = async (
      cause: unknown,
      resource: string,
      actorId?: string,
    ): Promise<NextResponse> => {
      const r = await deps.errors.handle(cause, {
        correlationId,
        resource,
        ...(actorId ? { actorId } : {}),
      });
      // Un navegador que pide una pagina del area privada sin sesion va a la entrada; las
      // llamadas de API siguen recibiendo 401 en JSON. La auditoria ya quedo registrada.
      const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');
      if (r.status === 401 && wantsHtml && !resource.startsWith('/api/')) {
        const target = isOperatorPath(resource) ? '/operador/acceso' : '/acceso?caducada=1';
        return decorate(NextResponse.redirect(new URL(target, req.url)));
      }
      return decorate(NextResponse.json(r.body, { status: r.status, headers: r.headers }));
    };

    try {
      const pathname = maskPathForLogs(req.nextUrl.pathname);
      const rawPath = req.nextUrl.pathname;
      const rule = resolveRoute(deps.table, rawPath);

      // SECURITY-08: lo que no esta registrado no se sirve.
      if (!rule) return await fail(appError('not_found'), pathname);

      let actorId: string | undefined;
      let loginAt: number | undefined;
      let setCookies: readonly string[] = [];
      if (rule.access === 'artist' || rule.access === 'operator') {
        if (rule.access === 'operator' && !deps.operatorSessions) {
          return await fail(appError('not_found'), pathname);
        }
        const resolver =
          rule.access === 'operator' ? (deps.operatorSessions ?? deps.sessions) : deps.sessions;
        const session = await resolver.resolve(req.headers);
        if (!session) return await fail(appError('unauthenticated'), pathname);
        if (session.role !== rule.access) {
          return await fail(appError('forbidden'), pathname, session.userId);
        }
        actorId = session.userId;
        loginAt = session.loginAt;
        setCookies = session.setCookies ?? [];
      }

      if (rule.rateLimit) {
        const limited = await deps.limiter.check(rule.rateLimit, clientIp(req.headers), {
          failClosed: rule.failClosed ?? false,
          correlationId,
        });
        if (!limited.ok) return await fail(limited.error satisfies AppError, pathname, actorId);
      }

      // Se propagan al render: Next.js lee el nonce de la CSP de la peticion.
      const requestHeaders = new Headers(req.headers);
      // Nunca se confia en cabeceras internas enviadas por el cliente: se borran siempre y solo
      // el proxy fija la identidad autenticada para el resto de la aplicacion.
      for (const name of [...requestHeaders.keys()]) {
        if (name.toLowerCase().startsWith('x-ml-')) requestHeaders.delete(name);
      }
      if (actorId) {
        requestHeaders.set(
          rule.access === 'operator' ? 'x-ml-operator' : 'x-ml-artist-id',
          actorId,
        );
      }
      if (loginAt !== undefined) requestHeaders.set('x-ml-login-at', String(loginAt));
      requestHeaders.set('x-correlation-id', correlationId);
      requestHeaders.set('x-nonce', nonce);
      requestHeaders.set('Content-Security-Policy', sec['Content-Security-Policy'] ?? '');
      const response = decorate(NextResponse.next({ request: { headers: requestHeaders } }));
      // El token de seguimiento viaja en la ruta: ningun enlace saliente debe llevarlo (NFR-U3-22).
      if (rawPath.startsWith('/seguimiento/')) {
        response.headers.set('Referrer-Policy', 'no-referrer');
      } else if (isOperatorPath(rawPath)) {
        // `no-referrer` haria que el navegador enviara `Origin: null` en las acciones de servidor
        // (Next.js las rechaza); `same-origin` no filtra nada hacia fuera y conserva el origen.
        response.headers.set('Referrer-Policy', 'same-origin');
      }
      // Renovacion de tokens o de actividad calculada al resolver la sesion.
      for (const cookie of setCookies) response.headers.append('set-cookie', cookie);
      return response;
    } catch (cause) {
      // Falla cerrado (BR-R4).
      deps.logger.error('pipeline_failure', { correlationId });
      return await fail(cause, maskPathForLogs(req.nextUrl.pathname));
    }
  };
};
