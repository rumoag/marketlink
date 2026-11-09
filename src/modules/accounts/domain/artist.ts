import { z } from 'zod';
import { phoneSchema } from '@/modules/kernel/domain/schemas';
import type { Email, PhoneES } from '@/modules/kernel/domain/formats';
import type { Instant } from '@/modules/kernel/domain/clock';
import { parseInstagram, type InstagramHandle } from './instagram-handle';
import { parsePeninsularPostalCode, type PeninsularPostalCode } from './postal';
import { provinceMatchesPostalCode } from './provinces';

export type Artist = {
  readonly id: string;
  readonly email: Email;
  readonly artisticName: string | undefined;
  readonly instagram: InstagramHandle | undefined;
  readonly phone: PhoneES | undefined;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

/** BR2-PF4: perfil completo con los tres campos presentes. */
export const isProfileComplete = (
  a: Pick<Artist, 'artisticName' | 'instagram' | 'phone'>,
): boolean => a.artisticName !== undefined && a.instagram !== undefined && a.phone !== undefined;

export type SenderAddress = {
  readonly artistId: string;
  readonly street: string;
  readonly number: string;
  readonly floorDoor: string;
  readonly postalCode: PeninsularPostalCode;
  readonly city: string;
  readonly province: string;
  readonly phone: PhoneES;
  readonly country: 'ES';
};

/** Texto de una linea: sin caracteres de control y compactado. */
const hasControlChars = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
};

const line = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, ' '))
    .refine((s) => s.length >= min && s.length <= max && !hasControlChars(s));

const instagramSchema = z
  .string()
  .max(64)
  .transform((raw, ctx) => {
    const r = parseInstagram(raw);
    if (!r.ok) {
      ctx.addIssue({ code: 'custom', message: 'invalid' });
      return z.NEVER;
    }
    return r.value;
  });

const peninsularPostalSchema = z
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

/** BR2-PF1 a PF4. */
export const profileSchema = z.object({
  artisticName: line(2, 60),
  instagram: instagramSchema,
  phone: phoneSchema,
});
export type ProfileInput = z.infer<typeof profileSchema>;

/** BR2-DR1 a DR3: la provincia debe corresponder al codigo postal. */
export const addressSchema = z
  .object({
    street: line(2, 120),
    number: line(1, 10),
    floorDoor: z
      .string()
      .optional()
      .transform((s) => (s ?? '').trim().replace(/\s+/g, ' '))
      .refine((s) => s.length <= 20 && !hasControlChars(s)),
    postalCode: peninsularPostalSchema,
    city: line(2, 60),
    province: line(2, 40),
    phone: phoneSchema,
  })
  .superRefine((value, ctx) => {
    if (!provinceMatchesPostalCode(value.postalCode, value.province)) {
      ctx.addIssue({ code: 'custom', path: ['province'], message: 'mismatch' });
    }
  });
export type AddressInput = z.infer<typeof addressSchema>;
