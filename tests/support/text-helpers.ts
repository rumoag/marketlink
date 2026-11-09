/** Referencias independientes de la implementacion para comprobar las reglas de texto. */

/** Hay caracteres de control (salvo el salto de linea si `allowNewline`). */
export const hasControl = (s: string, allowNewline: boolean): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (allowNewline && code === 10) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
};

export const isTitleOk = (normalized: string): boolean =>
  normalized.length >= 3 && normalized.length <= 80;

export const isDescriptionOk = (normalized: string): boolean => normalized.length <= 1000;
