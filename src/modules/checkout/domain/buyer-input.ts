import { z } from 'zod';
import { emailSchema, phoneSchema } from '@/modules/kernel/domain/schemas';
import { parsePeninsularPostalCode } from '@/modules/accounts/domain/postal';
import { provinceMatchesPostalCode } from '@/modules/accounts/domain/provinces';

/** Texto de una linea: recortado, espacios compactados y sin caracteres de control. */
const hasControlChars = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
};

export const normalizeLine = (raw: string): string => raw.trim().replace(/\s+/g, ' ');

const line = (min: number, max: number) =>
  z
    .string()
    .max(max * 4)
    .transform(normalizeLine)
    .refine((s) => s.length >= min && s.length <= max && !hasControlChars(s));

const optionalLine = (max: number) =>
  z
    .string()
    .max(max * 4)
    .optional()
    .transform((s) => normalizeLine(s ?? ''))
    .refine((s) => s.length <= max && !hasControlChars(s));

const peninsularPostal = z
  .string()
  .max(16)
  .transform((raw, ctx) => {
    const r = parsePeninsularPostalCode(raw);
    if (!r.ok) {
      ctx.addIssue({ code: 'custom', message: r.error });
      return z.NEVER;
    }
    return r.value;
  });

/**
 * Datos de la compradora (BR3-FM1, BR3-FM2). Los mensajes de error no repiten el valor recibido.
 * La aceptacion de condiciones y la alternativa de envio son campos aparte.
 */
export const buyerInputSchema = z
  .object({
    name: line(2, 80),
    email: emailSchema,
    phone: phoneSchema,
    street: line(3, 120),
    complement: optionalLine(60),
    postalCode: peninsularPostal,
    city: line(2, 80),
    province: line(2, 40),
  })
  .superRefine((value, ctx) => {
    if (!provinceMatchesPostalCode(value.postalCode, value.province)) {
      ctx.addIssue({ code: 'custom', path: ['province'], message: 'mismatch' });
    }
  });
export type BuyerInput = z.infer<typeof buyerInputSchema>;

/** Campos del formulario tal como llegan, para normalizar sin validar (idempotente, P-U3-06). */
export const normalizeBuyerFields = (raw: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = normalizeLine(v);
  return out;
};

/** Solo el codigo postal, para cotizar antes de tener el resto de los datos. */
export const quotePostalSchema = peninsularPostal;
