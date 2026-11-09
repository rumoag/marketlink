import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { AppError } from '@/modules/kernel/domain/app-error';
import type { RateLimiter } from './rate-limiter';

/**
 * Contexto de datos de una transaccion (EN-03): las politicas RLS solo muestran las filas del
 * artista indicado, o todas si el contexto es del sistema (webhooks, trabajos, vista publica).
 */
export type Scope =
  { readonly kind: 'artist'; readonly artistId: string } | { readonly kind: 'system' };

export const systemScope: Scope = { kind: 'system' };
export const artistScope = (artistId: string): Scope => ({ kind: 'artist', artistId });

/** Ejecuta `fn` dentro de una transaccion con el contexto aplicado; si lanza, deshace todo. */
export interface TransactionRunner<R> {
  run<T>(scope: Scope, fn: (repos: R) => Promise<T>): Promise<T>;
}

/** Aplica una regla de limite de tasa y la traduce a Result. */
export const enforceLimit = async (
  limiter: Pick<RateLimiter, 'check'>,
  rule: string,
  subject: string,
  options: { failClosed: boolean; correlationId: string },
): Promise<Result<void, AppError>> => {
  const r = await limiter.check(rule, subject, options);
  return r.ok ? ok(undefined) : err(r.error);
};
