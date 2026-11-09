import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { addMs, MS, type Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { IdGenerator, Logger } from '@/modules/platform/application/ports';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import {
  artistScope,
  enforceLimit,
  systemScope,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import { validateUpload, type PhotoError } from '../domain/photo-rules';
import type { ImageProcessor, ListingsRepos, PhotoStorage } from './ports';

/** Las subidas sin enlace caducan a las 24 horas (P2-FOT-1). */
export const UPLOAD_TTL_MS = 24 * MS.hour;
/** Vigencia de las URL firmadas de las fotos. */
export const SIGNED_URL_TTL_SECONDS = 3600;

export type PhotoServiceDeps = {
  readonly runner: TransactionRunner<ListingsRepos>;
  readonly storage: PhotoStorage;
  readonly processor: ImageProcessor;
  readonly limiter: Pick<RateLimiter, 'check'>;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
};

export type UploadedPhoto = { readonly uploadId: string; readonly previewUrl: string | undefined };

/** Mensaje de campo para cada motivo de rechazo; nunca refleja el contenido (BR2-FT7). */
const photoValidation = (_reason: PhotoError): AppError =>
  appError('validation', { details: [{ field: 'photos', reason: 'invalido' }] });

export class PhotoService {
  constructor(private readonly deps: PhotoServiceDeps) {}

  /**
   * US-007: valida por contenido, procesa (sin metadatos, dos tamanos, WebP), guarda en
   * almacenamiento privado y registra una subida pendiente. Si algo falla, no queda nada.
   */
  async upload(
    artistId: string,
    bytes: Uint8Array,
    correlationId: string,
  ): Promise<Result<UploadedPhoto, AppError>> {
    const limited = await enforceLimit(this.deps.limiter, 'photo_upload_artist', artistId, {
      failClosed: false,
      correlationId,
    });
    if (!limited.ok) return limited;

    const checked = validateUpload(bytes);
    if (!checked.ok) return err(photoValidation(checked.error));

    const startedAt = this.deps.clock.now();
    const processed = await this.deps.processor.process(bytes);
    if (!processed.ok) return err(photoValidation(processed.error));
    this.deps.logger.info('photo_processed', {
      durationMs: this.deps.clock.now() - startedAt,
      inputBytes: bytes.byteLength,
      correlationId,
    });

    const base = `${artistId}/${this.deps.ids.uuid()}`;
    const fullKey = `${base}-1600.webp`;
    const thumbKey = `${base}-480.webp`;
    const { full, thumb } = processed.value;

    const putFull = await this.deps.storage.put(fullKey, full.bytes, 'image/webp');
    if (!putFull.ok) return putFull;
    const putThumb = await this.deps.storage.put(thumbKey, thumb.bytes, 'image/webp');
    if (!putThumb.ok) {
      await this.cleanup([fullKey], correlationId);
      return putThumb;
    }

    const now = this.deps.clock.now();
    const uploadId = this.deps.ids.uuid();
    try {
      await this.deps.runner.run(artistScope(artistId), (repos) =>
        repos.uploads.insert(
          {
            id: uploadId,
            artistId,
            storageKeyFull: fullKey,
            storageKeyThumb: thumbKey,
            width: full.width,
            height: full.height,
            bytes: full.bytes.byteLength,
            status: 'pendiente',
            expiresAt: addMs(now, UPLOAD_TTL_MS),
          },
          now,
        ),
      );
    } catch (cause) {
      // R-07: sin fila no hay subida; se borran los objetos (si falla, la limpieza los encontrara).
      await this.cleanup([fullKey, thumbKey], correlationId);
      throw cause;
    }

    const signed = await this.deps.storage.signUrls([thumbKey], SIGNED_URL_TTL_SECONDS);
    return ok({
      uploadId,
      previewUrl: signed.ok ? signed.value.get(thumbKey) : undefined,
    });
  }

  /** Trabajo diario: borra subidas pendientes caducadas y sus objetos (P2-FOT-1). */
  async cleanupExpiredUploads(limit = 100): Promise<Result<{ removed: number }, AppError>> {
    const now = this.deps.clock.now();
    const expired = await this.deps.runner.run(systemScope, (repos) =>
      repos.uploads.findExpired(now, limit),
    );
    if (expired.length === 0) return ok({ removed: 0 });

    const keys = expired.flatMap((u) => [u.storageKeyFull, u.storageKeyThumb]);
    const removed = await this.deps.storage.remove(keys);
    // Si Storage falla se conservan las filas: el trabajo reintenta (nada queda huerfano).
    if (!removed.ok) return removed;
    await this.deps.runner.run(systemScope, (repos) =>
      repos.uploads.delete(expired.map((u) => u.id)),
    );
    return ok({ removed: expired.length });
  }

  private async cleanup(keys: readonly string[], correlationId: string): Promise<void> {
    const removed = await this.deps.storage.remove(keys);
    if (!removed.ok) {
      this.deps.logger.warn('photo_cleanup_failed', { count: keys.length, correlationId });
    }
  }
}
