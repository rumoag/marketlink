import { timingSafeEqual } from 'node:crypto';
import type { Secret } from '../application/config';

/** Compara un secreto recibido con el esperado en tiempo constante (SECURITY-12). */
export const secretMatches = (
  received: string | null | undefined,
  expected: Secret | undefined,
): boolean => {
  if (expected === undefined || received === null || received === undefined || received === '') {
    return false;
  }
  const a = Buffer.from(received);
  const b = Buffer.from(expected.reveal());
  // Se compara siempre el mismo numero de bytes para no filtrar la longitud por el tiempo.
  const length = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(length);
  const pb = Buffer.alloc(length);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb) && a.length === b.length;
};
