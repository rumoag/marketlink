import { err, ok, type Result } from '@/modules/kernel/domain/result';

/** Usuario de Instagram sin `@`, en minusculas (BR2-PF2). */
export type InstagramHandle = string & { readonly __brand: 'InstagramHandle' };

const ALLOWED = /^[a-z0-9._]{1,30}$/;

/** Recorta, quita un `@` inicial y pasa a minusculas. Idempotente (P-U2-04). */
export const normalizeInstagram = (raw: string): string => {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
};

export const parseInstagram = (raw: string): Result<InstagramHandle, 'invalid_instagram'> => {
  const n = normalizeInstagram(raw);
  if (!ALLOWED.test(n)) return err('invalid_instagram');
  if (n.startsWith('.') || n.endsWith('.') || n.includes('..')) return err('invalid_instagram');
  return ok(n as InstagramHandle);
};

export const InstagramHandle = { normalize: normalizeInstagram, parse: parseInstagram };
