import { createHash, timingSafeEqual } from 'node:crypto';

/** Resumen SHA-256 en hexadecimal (64 caracteres). Se usa para guardar tokens sin guardar el token. */
export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** Comparacion en tiempo constante de dos cadenas (no filtra en que posicion difieren). */
export const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};
