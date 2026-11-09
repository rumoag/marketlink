import { err, ok, type Result } from '@/modules/kernel/domain/result';
import { PostalCode } from '@/modules/kernel/domain/formats';
import { PENINSULAR_PREFIXES } from './provinces';

/** Codigo postal valido de la peninsula (BR2-DR2). Solo Baleares, Canarias, Ceuta y Melilla quedan fuera. */
export type PeninsularPostalCode = PostalCode & { readonly __zone: 'peninsula' };

export const EXCLUDED_PREFIXES: readonly string[] = ['07', '35', '38', '51', '52'];

export type PostalZoneError = 'invalid_postal_code' | 'outside_peninsula';

export const isPeninsularPrefix = (prefix: string): boolean => PENINSULAR_PREFIXES.includes(prefix);

export const parsePeninsularPostalCode = (
  raw: string,
): Result<PeninsularPostalCode, PostalZoneError> => {
  const base = PostalCode.parse(raw);
  if (!base.ok) return err('invalid_postal_code');
  return isPeninsularPrefix(base.value.slice(0, 2))
    ? ok(base.value as PeninsularPostalCode)
    : err('outside_peninsula');
};

export const PeninsularPostalCode = { parse: parsePeninsularPostalCode };
