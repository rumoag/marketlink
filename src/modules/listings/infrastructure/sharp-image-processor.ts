import sharp from 'sharp';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { ImageProcessor, ProcessedImage } from '../application/ports';
import { FULL_MAX_SIDE, THUMB_MAX_SIDE, type PhotoError } from '../domain/photo-rules';

/** Limite de entrada contra bombas de descompresion (40 megapixeles). */
export const MAX_INPUT_PIXELS = 40_000_000;
const WEBP_QUALITY = 82;

/**
 * Procesa una foto ya validada por firma y tamano (P2-FOT-2): comprueba que no es animada, gira
 * segun EXIF, elimina todos los metadatos (incluida la ubicacion GPS), reduce sin ampliar y genera
 * dos tamanos en WebP a partir de una sola decodificacion.
 */
export class SharpImageProcessor implements ImageProcessor {
  async process(bytes: Uint8Array): Promise<Result<ProcessedImage, PhotoError>> {
    try {
      const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const decode = () =>
        sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', animated: true });

      const meta = await decode().metadata();
      if (!meta.width || !meta.height) return err('unreadable');
      // Imagenes animadas o de varias paginas: se rechazan (P2-FOT-2).
      if ((meta.pages ?? 1) > 1) return err('unsupported_type');

      // sharp elimina los metadatos por defecto al no llamar a withMetadata().
      const base = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
      const render = (side: number) =>
        base
          .clone()
          .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: WEBP_QUALITY })
          .toBuffer({ resolveWithObject: true });

      const [full, thumb] = await Promise.all([render(FULL_MAX_SIDE), render(THUMB_MAX_SIDE)]);
      return ok({
        full: {
          bytes: new Uint8Array(full.data),
          width: full.info.width,
          height: full.info.height,
        },
        thumb: {
          bytes: new Uint8Array(thumb.data),
          width: thumb.info.width,
          height: thumb.info.height,
        },
      });
    } catch {
      // Fichero corrupto, truncado o fuera de limites: mensaje generico aguas arriba.
      return err('unreadable');
    }
  }
}
