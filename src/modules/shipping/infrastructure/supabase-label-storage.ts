import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { LabelStorage } from '../application/ports';

export const LABEL_BUCKET = 'labels';

export type SupabaseLabelOptions = {
  readonly url: string;
  /** Clave de servicio: unica forma de acceder al bucket privado. Solo servidor. */
  readonly serviceRoleKey: string;
  readonly fetch: typeof fetch;
};

/** Etiquetas PDF en un bucket privado; URLs firmadas de vida corta tras comprobar propiedad. */
export class SupabaseLabelStorage implements LabelStorage {
  private readonly client: SupabaseClient;

  constructor(options: SupabaseLabelOptions) {
    this.client = createClient(options.url, options.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: options.fetch },
    });
  }

  private get bucket() {
    return this.client.storage.from(LABEL_BUCKET);
  }

  async put(key: string, bytes: Uint8Array): Promise<Result<void, AppError>> {
    try {
      const { error } = await this.bucket.upload(key, bytes, {
        contentType: 'application/pdf',
        upsert: false,
      });
      return error ? err(appError('dependency_unavailable')) : ok(undefined);
    } catch {
      return err(appError('dependency_unavailable'));
    }
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<Result<string, AppError>> {
    try {
      const { data, error } = await this.bucket.createSignedUrl(key, ttlSeconds);
      return error || !data ? err(appError('dependency_unavailable')) : ok(data.signedUrl);
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
}
