import { MS, type Instant } from '@/modules/kernel/domain/clock';

/** Vigencia de la sesion del artista (BR2-AC7). Pura: la firma de la cookie vive en infraestructura. */
export const SESSION_IDLE_MS = 7 * MS.day;
export const SESSION_MAX_MS = 30 * MS.day;
/** `lastActivityAt` se renueva como mucho una vez cada 5 minutos. */
export const ACTIVITY_RENEW_MS = 5 * MS.minute;

export type SessionTimes = {
  readonly createdAt: Instant;
  readonly lastActivityAt: Instant;
};

/** Valida sii menos de 7 dias de inactividad y menos de 30 desde el inicio (P-U2-20). */
export const isSessionValid = (session: SessionTimes, now: Instant): boolean =>
  now - session.lastActivityAt < SESSION_IDLE_MS && now - session.createdAt < SESSION_MAX_MS;

export const shouldRenewActivity = (session: SessionTimes, now: Instant): boolean =>
  now - session.lastActivityAt >= ACTIVITY_RENEW_MS;
