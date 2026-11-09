import { createHmac, timingSafeEqual } from 'node:crypto';

/** Sesion de operador: cookie propia firmada, con caducidad por inactividad y absoluta (BR6-AC5). */
export const OPERATOR_COOKIE = 'ml_op';
export const IDLE_MS = 60 * 60_000;
export const ABSOLUTE_MS = 8 * 60 * 60_000;
/** La etapa pendiente (antes del TOTP) dura poco. */
export const PENDING_MS = 10 * 60_000;

export type OperatorStage = 'pendiente_mfa' | 'completa';

export type OperatorSession = {
  readonly email: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly stage: OperatorStage;
};

const sign = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body).digest('base64url');

const isStage = (v: unknown): v is OperatorStage => v === 'pendiente_mfa' || v === 'completa';

/** Valor de la cookie: `<cuerpo base64url>.<firma>`. */
export const encodeSession = (secret: string, s: OperatorSession): string => {
  const body = Buffer.from(
    JSON.stringify([s.email, s.createdAt, s.lastActivityAt, s.stage]),
  ).toString('base64url');
  return `${body}.${sign(secret, body)}`;
};

export type SessionVerdict =
  | { readonly ok: true; readonly session: OperatorSession }
  | { readonly ok: false; readonly reason: 'missing' | 'invalid' | 'expired' };

/**
 * Descifra y valida la cookie: firma en tiempo constante, forma, caducidad por inactividad
 * (60 min), caducidad absoluta (8 h) y, en la etapa pendiente, su plazo corto.
 */
export const decodeSession = (
  secret: string,
  cookie: string | undefined,
  nowMs: number,
): SessionVerdict => {
  if (!cookie) return { ok: false, reason: 'missing' };
  const dot = cookie.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'invalid' };
  const body = cookie.slice(0, dot);
  const given = Buffer.from(cookie.slice(dot + 1));
  const expected = Buffer.from(sign(secret, body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return { ok: false, reason: 'invalid' };
  const [email, createdAt, lastActivityAt, stage] = parsed as unknown[];
  if (
    typeof email !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof lastActivityAt !== 'number' ||
    !isStage(stage)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const session: OperatorSession = { email, createdAt, lastActivityAt, stage };
  if (isExpired(session, nowMs)) return { ok: false, reason: 'expired' };
  return { ok: true, session };
};

export const isExpired = (s: OperatorSession, nowMs: number): boolean =>
  nowMs - s.lastActivityAt > IDLE_MS ||
  nowMs - s.createdAt > ABSOLUTE_MS ||
  (s.stage === 'pendiente_mfa' && nowMs - s.createdAt > PENDING_MS) ||
  s.lastActivityAt > nowMs + 60_000;

/** Misma sesion con la actividad renovada. */
export const touch = (s: OperatorSession, nowMs: number): OperatorSession => ({
  ...s,
  lastActivityAt: nowMs,
});

/** Atributos de la cookie (`Secure` salvo en local). */
export const cookieHeader = (value: string, secure: boolean, maxAgeSeconds: number): string =>
  `${OPERATOR_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${
    secure ? '; Secure' : ''
  }`;

export const clearCookieHeader = (secure: boolean): string => cookieHeader('', secure, 0);

/** Valor de una cookie dentro de la cabecera `Cookie`. */
export const readCookie = (header: string | null, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
};
