import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { FinanceExportStorage } from '../application/ports';

export const FINANCE_BUCKET = 'finance-exports';

export type SupabaseFinanceOptions = {
  readonly url: string;
  /** Clave de servicio: unica forma de acceder al bucket privado. Solo servidor. */
  readonly serviceRoleKey: string;
  readonly fetch: typeof fetch;
};

/** Exportaciones contables mensuales en un bucket privado (CSV, sin datos personales). */
export class SupabaseFinanceExports implements FinanceExportStorage {
  private readonly client: SupabaseClient;

  constructor(options: SupabaseFinanceOptions) {
    this.client = createClient(options.url, options.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: options.fetch },
    });
  }

  async put(key: string, csv: string): Promise<Result<void, AppError>> {
    try {
      const { error } = await this.client.storage
        .from(FINANCE_BUCKET)
        .upload(key, new TextEncoder().encode(csv), { contentType: 'text/csv', upsert: true });
      return error ? err(appError('dependency_unavailable')) : ok(undefined);
    } catch {
      return err(appError('dependency_unavailable'));
    }
  }
}
