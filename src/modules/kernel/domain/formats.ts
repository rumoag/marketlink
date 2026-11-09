import { err, ok, type Result } from './result';

export type FormatErrorCode = 'invalid_postal_code' | 'invalid_phone' | 'invalid_email';

export type PostalCode = string & { readonly __brand: 'PostalCode' };
export type PhoneES = string & { readonly __brand: 'PhoneES' };
export type Email = string & { readonly __brand: 'Email' };

// BR-F1: 5 digitos con prefijo de provincia 01 a 52.
const POSTAL = /^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/;
// BR-F2: forma canonica +34 y 9 digitos que empiezan por 6, 7, 8 o 9.
const PHONE = /^\+34[6-9]\d{8}$/;
// BR-F3: una sola @, dominio con punto, sin espacios.
const EMAIL = /^[^\s@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** BR-F4: todas las normalizaciones son idempotentes. */
export const normalizePostalCode = (raw: string): string => raw.replace(/\s+/g, '');

export const normalizePhone = (raw: string): string => {
  const stripped = raw.replace(/[\s\-.()]/g, '');
  if (stripped.startsWith('0034')) return `+34${stripped.slice(4)}`;
  if (stripped.startsWith('+34')) return stripped;
  if (/^\d{9}$/.test(stripped)) return `+34${stripped}`;
  return stripped;
};

export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

export const PostalCode = {
  normalize: normalizePostalCode,
  parse: (raw: string): Result<PostalCode, FormatErrorCode> => {
    const n = normalizePostalCode(raw);
    return POSTAL.test(n) ? ok(n as PostalCode) : err('invalid_postal_code');
  },
};

export const PhoneES = {
  normalize: normalizePhone,
  parse: (raw: string): Result<PhoneES, FormatErrorCode> => {
    const n = normalizePhone(raw);
    return PHONE.test(n) ? ok(n as PhoneES) : err('invalid_phone');
  },
};

export const Email = {
  normalize: normalizeEmail,
  parse: (raw: string): Result<Email, FormatErrorCode> => {
    const n = normalizeEmail(raw);
    return n.length <= 254 && EMAIL.test(n) ? ok(n as Email) : err('invalid_email');
  },
};
