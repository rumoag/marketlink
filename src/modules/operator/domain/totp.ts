import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** TOTP RFC 6238 (SHA-1, 6 digitos, paso de 30 s). Puro: el reloj llega como parametro. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Tolerancia de reloj: el paso actual y uno antes/despues. */
export const TOTP_WINDOW = 1;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (text: string): Uint8Array | undefined => {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return undefined;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
};

/** Secreto nuevo de 20 bytes (160 bits) en Base32. */
export const generateSecret = (): string => base32Encode(randomBytes(20));

/** Paso TOTP que corresponde a un instante (ms). */
export const stepOf = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

/** HOTP (RFC 4226) para un contador. */
export const hotp = (secret: Uint8Array, counter: number): string => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(buf).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
};

/** Codigo TOTP de un paso concreto (para pruebas y para el script de alta). */
export const totpAtStep = (secretBase32: string, step: number): string | undefined => {
  const secret = base32Decode(secretBase32);
  return secret ? hotp(secret, step) : undefined;
};

const sameCode = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export type TotpVerdict =
  | { readonly ok: true; readonly step: number }
  | { readonly ok: false; readonly reason: 'format' | 'invalid' | 'reused' };

/**
 * Verifica un codigo contra la ventana de pasos. Solo se aceptan pasos mayores que el ultimo
 * aceptado (`lastStep`): un codigo ya usado, o uno anterior, se rechaza aunque siga vigente.
 * Se recorre siempre toda la ventana para no filtrar por tiempo cual paso acerto.
 */
export const verifyTotp = (
  secretBase32: string,
  code: string,
  nowMs: number,
  lastStep: number,
): TotpVerdict => {
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code)) return { ok: false, reason: 'format' };
  const secret = base32Decode(secretBase32);
  if (!secret || secret.length === 0) return { ok: false, reason: 'invalid' };
  const now = stepOf(nowMs);
  let matched: number | undefined;
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) {
    const step = now + delta;
    if (step < 0) continue;
    if (sameCode(hotp(secret, step), code) && matched === undefined) matched = step;
  }
  if (matched === undefined) return { ok: false, reason: 'invalid' };
  if (matched <= lastStep) return { ok: false, reason: 'reused' };
  return { ok: true, step: matched };
};

/** URI para la aplicacion de autenticacion (se muestra una sola vez al dar de alta). */
export const otpauthUri = (issuer: string, email: string, secretBase32: string): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}` +
  `?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1` +
  `&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
