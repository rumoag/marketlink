import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@/modules/kernel/domain/hash';
import type { Instant } from '@/modules/kernel/domain/clock';
import type { Consent } from '@/modules/orders/domain/order';

/** Versiones de los textos legales (provisionales, BR3-CS3). Subir la version al cambiar el texto. */
export const PRIVACY_VERSION = 'privacidad@v0-provisional';
export const TERMS_VERSION = 'condiciones@v0-provisional';

export const consentAt = (acceptedAt: Instant): Consent => ({
  privacyVersion: PRIVACY_VERSION,
  termsVersion: TERMS_VERSION,
  acceptedAt,
});

/** Duracion de la cookie de reintento (BR3-RT*): una hora. */
export const RESUME_COOKIE_NAME = 'ml_reintento';
export const RESUME_TTL_MS = 60 * 60_000;

/** Identificador de la cookie de reintento: 128 bits, sin datos personales (NFR-U3-19). */
export const newResumeId = (): string => randomBytes(16).toString('base64url');
export const hashResumeId = (id: string): string => sha256Hex(`reintento:${id}`);
export const isWellFormedResumeId = (raw: string): boolean => /^[A-Za-z0-9_-]{22}$/.test(raw);

/** Clave de envio del formulario (idempotencia de la peticion, Q2 A de NFR Design). */
export const isWellFormedSubmissionKey = (raw: string): boolean =>
  /^[A-Za-z0-9_-]{16,64}$/.test(raw);
export const newSubmissionKey = (): string => randomBytes(16).toString('base64url');

/** La cookie solo rellena el formulario si aun vigente (P-U3-15). */
export const resumeStillValid = (expiresAt: Instant | undefined, now: Instant): boolean =>
  expiresAt !== undefined && expiresAt > now;
