import type { Random } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';

/** BR2-SL1: 8 caracteres de un alfabeto sin ambiguedades (sin i, l, o, 0 ni 1). 31^8 combinaciones. */
export const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const SLUG_LENGTH = 8;

export type Slug = string & { readonly __brand: 'Slug' };

/** Genera un slug con una fuente aleatoria inyectable (segura en produccion). */
export const generateSlug = (random: Random): Slug => {
  let out = '';
  for (let i = 0; i < SLUG_LENGTH; i++) {
    const index = Math.min(
      SLUG_ALPHABET.length - 1,
      Math.floor(random.next() * SLUG_ALPHABET.length),
    );
    out += SLUG_ALPHABET[index];
  }
  return out as Slug;
};

/** BR2-SL4: recorta y pasa a minusculas. Idempotente (P-U2-02). */
export const normalizeSlug = (raw: string): string => raw.trim().toLowerCase();

export const parseSlug = (raw: string): Result<Slug, 'invalid_slug'> => {
  const n = normalizeSlug(raw);
  if (n.length !== SLUG_LENGTH) return err('invalid_slug');
  for (const ch of n) {
    if (!SLUG_ALPHABET.includes(ch)) return err('invalid_slug');
  }
  return ok(n as Slug);
};

export const Slug = { generate: generateSlug, normalize: normalizeSlug, parse: parseSlug };
