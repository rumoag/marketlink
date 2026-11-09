/** Normalizacion de textos del enlace (BR2-DT1, BR2-DT2). Funciones idempotentes (P-U2-07). */

const isControl = (code: number): boolean => code < 32 || code === 127;

/** Quita los caracteres de control salvo (si se pide) el salto de linea. */
const stripControl = (s: string, keepNewline: boolean): string => {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (keepNewline && code === 10) out += s[i];
    else if (!isControl(code)) out += s[i];
  }
  return out;
};

/** Titulo: una sola linea, espacios compactados y recortado. */
export const normalizeTitle = (raw: string): string =>
  stripControl(raw.replace(/\s+/g, ' '), false).replace(/\s+/g, ' ').trim();

/** Descripcion: texto plano con saltos de linea normalizados a `\n`; sin caracteres de control. */
export const normalizeDescription = (raw: string): string =>
  stripControl(raw.replace(/\r\n|\r/g, '\n'), true).trim();

export const TITLE_MIN = 3;
export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 1000;

export const isValidTitle = (normalized: string): boolean =>
  normalized.length >= TITLE_MIN && normalized.length <= TITLE_MAX;

export const isValidDescription = (normalized: string): boolean =>
  normalized.length <= DESCRIPTION_MAX;
