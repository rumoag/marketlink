import {
  FULL_MAX_SIDE,
  MAX_UPLOAD_BYTES,
  targetDimensions,
} from '@/modules/listings/domain/photo-rules';

/**
 * Reduce la foto en el navegador antes de subirla (ahorra datos moviles y cabe en el limite de
 * 4 MB). Es solo una ayuda: el servidor vuelve a validar y a procesar siempre (P2-FOT-1).
 * Dibujar en un canvas descarta ademas los metadatos de la foto.
 */
export async function resizeForUpload(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const { width, height } = targetDimensions(bitmap.width, bitmap.height, FULL_MAX_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.88),
    );
    // Si por algun motivo el resultado pesa mas que el original, se sube el original.
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file; // formato que el navegador no decodifica: decide el servidor
  }
}

export const TOO_LARGE = (blob: Blob): boolean => blob.size > MAX_UPLOAD_BYTES;
