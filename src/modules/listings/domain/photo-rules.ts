import { err, ok, type Result } from '@/modules/kernel/domain/result';

/** Reglas de fotos (BR2-FT1 a FT7). Puras: el procesado real de imagen vive en infraestructura. */
export const MIN_PHOTOS = 1;
export const MAX_PHOTOS = 3;
/** Limite del servidor por peticion (el tope de las funciones de Vercel es de unos 4,5 MB). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const FULL_MAX_SIDE = 1600;
export const THUMB_MAX_SIDE = 480;

export type DetectedImageType = 'jpeg' | 'png' | 'webp';

export type PhotoError = 'empty' | 'too_large' | 'unsupported_type' | 'unreadable' | 'bad_count';

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((b, i) => bytes[offset + i] === b);

/**
 * BR2-FT2: el tipo se decide por la firma de los primeros bytes, nunca por la extension ni por el
 * tipo declarado por el cliente (P-U2-17).
 */
export const detectImageType = (bytes: Uint8Array): DetectedImageType | null => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  // WebP: "RIFF" + 4 bytes de tamano + "WEBP"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'webp';
  }
  return null;
};

/** Valida una subida antes de decodificarla: no vacia, dentro del limite y de tipo permitido. */
export const validateUpload = (bytes: Uint8Array): Result<DetectedImageType, PhotoError> => {
  if (bytes.byteLength === 0) return err('empty');
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return err('too_large');
  const type = detectImageType(bytes);
  return type === null ? err('unsupported_type') : ok(type);
};

/** BR2-FT1: un enlace lleva de 1 a 3 fotos. */
export const isValidPhotoCount = (count: number): boolean =>
  Number.isInteger(count) && count >= MIN_PHOTOS && count <= MAX_PHOTOS;

/**
 * Dimensiones tras reducir: el lado largo pasa a min(original, maxSide) y se conserva la
 * proporcion; nunca se amplia (P-U2-19).
 */
export const targetDimensions = (
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } => {
  const longSide = Math.max(width, height);
  if (longSide <= maxSide) return { width, height };
  const scale = maxSide / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

/** BR2-FT6: tras quitar fotos las posiciones quedan 1..n sin huecos. */
export const compactPositions = <T extends { readonly position: number }>(
  photos: readonly T[],
): T[] =>
  [...photos]
    .sort((a, b) => a.position - b.position)
    .map((photo, index) => ({ ...photo, position: index + 1 }));

/** BR2-FT6: no se puede quitar una foto si dejaria el enlace con menos de una. */
export const canRemovePhoto = (currentCount: number): boolean => currentCount > MIN_PHOTOS;
