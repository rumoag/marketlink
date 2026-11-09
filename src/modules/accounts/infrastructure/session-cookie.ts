import { createHmac, timingSafeEqual } from 'node:crypto';
import { MS, instantOf, type Instant } from '@/modules/kernel/domain/clock';
import type { AuthSession } from '../application/ports';
import { SESSION_MAX_MS, type SessionTimes } from '../domain/session';

/** Nombres de las cookies de sesion del artista. */
export const COOKIE_ACCESS = 'ml_at';
export const COOKIE_REFRESH = 'ml_rt';
export const COOKIE_ACTIVITY = 'ml_act';

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

const sign = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(payload).digest('hex');

/** Cookie de actividad firmada: `base64url(json).hmac` (P2-SES-1). */
export const encodeActivityCookie = (times: SessionTimes, secret: string): string => {
  const payload = b64url(JSON.stringify({ c: times.createdAt, a: times.lastActivityAt }));
  return `${payload}.${sign(payload, secret)}`;
};

/** Devuelve las fechas si la firma es correcta; cualquier otra cosa es `null` (sin lanzar). */
export const decodeActivityCookie = (
  value: string | undefined,
  secret: string,
): SessionTimes | null => {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const received = Buffer.from(value.slice(dot + 1), 'utf8');
  const expected = Buffer.from(sign(payload, secret), 'utf8');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const parsed = JSON.parse(unb64url(payload)) as { c?: unknown; a?: unknown };
    if (typeof parsed.c !== 'number' || typeof parsed.a !== 'number') return null;
    if (!Number.isFinite(parsed.c) || !Number.isFinite(parsed.a)) return null;
    return { createdAt: instantOf(parsed.c), lastActivityAt: instantOf(parsed.a) };
  } catch {
    return null;
  }
};

export const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== '' && !(name in out)) out[name] = part.slice(eq + 1).trim();
  }
  return out;
};

/** BR2-AC8: HttpOnly, Secure (salvo desarrollo en http) y SameSite=Lax. */
export const serializeCookie = (
  name: string,
  value: string,
  options: { maxAgeSeconds: number; secure: boolean },
): string =>
  [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');

const MAX_AGE_SECONDS = Math.floor(SESSION_MAX_MS / MS.second);

export const accessCookie = (token: string, secure: boolean): string =>
  serializeCookie(COOKIE_ACCESS, token, { maxAgeSeconds: MAX_AGE_SECONDS, secure });
export const refreshCookie = (token: string, secure: boolean): string =>
  serializeCookie(COOKIE_REFRESH, token, { maxAgeSeconds: MAX_AGE_SECONDS, secure });
export const activityCookie = (times: SessionTimes, secret: string, secure: boolean): string =>
  serializeCookie(COOKIE_ACTIVITY, encodeActivityCookie(times, secret), {
    maxAgeSeconds: MAX_AGE_SECONDS,
    secure,
  });

/** Cookies de una sesion recien abierta: ambos tokens y la actividad con la hora actual. */
export const buildSessionCookies = (
  session: Pick<AuthSession, 'accessToken' | 'refreshToken'>,
  now: Instant,
  secret: string,
  secure: boolean,
): string[] => [
  accessCookie(session.accessToken, secure),
  refreshCookie(session.refreshToken, secure),
  activityCookie({ createdAt: now, lastActivityAt: now }, secret, secure),
];

/** Cerrar sesion: borra las tres cookies. */
export const clearSessionCookies = (secure: boolean): string[] =>
  [COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_ACTIVITY].map((name) =>
    serializeCookie(name, '', { maxAgeSeconds: 0, secure }),
  );

/** Cookie descrita como datos, para fijarla desde acciones de servidor con la API de Next.js. */
export type CookieSpec = {
  readonly name: string;
  readonly value: string;
  readonly maxAge: number;
  readonly secure: boolean;
};

/** Las tres cookies de una sesion recien abierta, siempre HttpOnly y SameSite=Lax. */
export const buildSessionCookieSpecs = (
  session: Pick<AuthSession, 'accessToken' | 'refreshToken'>,
  now: Instant,
  secret: string,
  secure: boolean,
): CookieSpec[] => [
  { name: COOKIE_ACCESS, value: session.accessToken, maxAge: MAX_AGE_SECONDS, secure },
  { name: COOKIE_REFRESH, value: session.refreshToken, maxAge: MAX_AGE_SECONDS, secure },
  {
    name: COOKIE_ACTIVITY,
    value: encodeActivityCookie({ createdAt: now, lastActivityAt: now }, secret),
    maxAge: MAX_AGE_SECONDS,
    secure,
  },
];

export const SESSION_COOKIE_NAMES: readonly string[] = [
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  COOKIE_ACTIVITY,
];
