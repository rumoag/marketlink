import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { PhotoStorage } from '../application/ports';

export const PHOTO_BUCKET = 'listing-images';

export type SupabaseStorageOptions = {
  readonly url: string;
  /** Clave de servicio: unica forma de acceder al bucket privado. Solo servidor. */
  readonly serviceRoleKey: string;
  readonly fetch: typeof fetch;
};

/** Almacenamiento privado de fotos en Supabase Storage (URLs firmadas de vida corta). */
export class SupabasePhotoStorage implements PhotoStorage {
  private readonly client: SupabaseClient;

  constructor(options: SupabaseStorageOptions) {
    this.client = createClient(options.url, options.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: options.fetch },
    });
  }

  private get bucket() {
    return this.client.storage.from(PHOTO_BUCKET);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<Result<void, AppError>> {
    try {
      const { error } = await this.bucket.upload(key, bytes, { contentType, upsert: false });
      return error ? err(appError('dependency_unavailable')) : ok(undefined);
    } catch {
      return err(appError('dependency_unavailable'));
    }
  }

  async remove(keys: readonly string[]): Promise<Result<void, AppError>> {
    if (keys.length === 0) return ok(undefined);
    try {
      const { error } = await this.bucket.remove([...keys]);
      return error ? err(appError('dependency_unavailable')) : ok(undefined);
    } catch {
      return err(appError('dependency_unavailable'));
    }
  }

  async signUrls(
    keys: readonly string[],
    ttlSeconds: number,
  ): Promise<Result<ReadonlyMap<string, string>, AppError>> {
    if (keys.length === 0) return ok(new Map());
    try {
      const { data, error } = await this.bucket.createSignedUrls([...keys], ttlSeconds);
      if (error || !data) return err(appError('dependency_unavailable'));
      const map = new Map<string, string>();
      for (const item of data) {
        if (item.path && item.signedUrl) map.set(item.path, item.signedUrl);
      }
      return ok(map);
    } catch {
      return err(appError('dependency_unavailable'));
    }
  }
}
