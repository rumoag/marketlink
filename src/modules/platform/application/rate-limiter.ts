import type { Clock } from '@/modules/kernel/domain/clock';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { RateLimitRuleName } from '../domain/route-table';
import type { AuditLog } from './audit-log';
import type { Logger } from './ports';

export type RateLimitRule = { readonly limit: number; readonly windowSeconds: number };

/** Limites de BR-L (seccion 7 de business-rules.md). */
export const RATE_LIMIT_RULES: Readonly<Record<RateLimitRuleName, RateLimitRule>> = {
  magic_link_email: { limit: 5, windowSeconds: 3600 },
  magic_link_ip: { limit: 20, windowSeconds: 3600 },
  quote_ip: { limit: 20, windowSeconds: 600 },
  checkout_ip: { limit: 10, windowSeconds: 60 },
  tracking_ip: { limit: 60, windowSeconds: 60 },
  reserve_ip: { limit: 5, windowSeconds: 3600 },
  // U3: reservas sin pagar por enlace y hora (NFR-U3-16).
  reserve_listing: { limit: 10, windowSeconds: 3600 },
  // U5: retiradas por artista y hora (NFR-U5-14).
  withdraw_artist: { limit: 5, windowSeconds: 3600 },
  // U6: panel del operador (NFR-U6-15, 19).
  operator_link_ip: { limit: 10, windowSeconds: 3600 },
  operator_panel: { limit: 120, windowSeconds: 60 },
  operator_action: { limit: 10, windowSeconds: 60 },
  listing_view: { limit: 120, windowSeconds: 3600 },
  // U2: acciones del artista (sujeto = su identificador).
  photo_upload_artist: { limit: 30, windowSeconds: 3600 },
  listing_create_artist: { limit: 20, windowSeconds: 3600 },
  profile_save_artist: { limit: 30, windowSeconds: 3600 },
  payout_onboarding_artist: { limit: 10, windowSeconds: 3600 },
};

/** Incremento atomico del contador (rule, sujeto, ventana). Devuelve el nuevo valor (BR-L1). */
export interface CounterStore {
  increment(rule: string, subjectHash: string, windowStartSeconds: number): Promise<number>;
}

/** Resumen con sal secreta del sujeto: nunca se guarda la IP ni el email en claro (BR-L3). */
export type SubjectHasher = (rule: string, subject: string) => string;

export type RateLimiterDeps = {
  readonly store: CounterStore;
  readonly hasher: SubjectHasher;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly rules?: Readonly<Record<string, RateLimitRule>>;
};

export type CheckOptions = {
  readonly failClosed: boolean;
  readonly correlationId: string;
};

export class RateLimiter {
  private readonly rules: Readonly<Record<string, RateLimitRule>>;

  constructor(private readonly deps: RateLimiterDeps) {
    this.rules = deps.rules ?? RATE_LIMIT_RULES;
  }

  async check(
    rule: string,
    subject: string,
    options: CheckOptions,
  ): Promise<Result<{ remaining: number }, AppError>> {
    const def = this.rules[rule];
    if (!def) return err(appError('internal'));

    const nowMs = this.deps.clock.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const windowStart = Math.floor(nowSeconds / def.windowSeconds) * def.windowSeconds;

    let count: number;
    try {
      count = await this.deps.store.increment(rule, this.deps.hasher(rule, subject), windowStart);
    } catch {
      this.deps.logger.warn('rate_limit_store_failed', {
        rule,
        failClosed: options.failClosed,
        correlationId: options.correlationId,
      });
      // BR-L4: rutas de autenticacion y de pago fallan cerradas.
      return options.failClosed ? err(appError('dependency_unavailable')) : ok({ remaining: 0 });
    }

    if (count <= def.limit) return ok({ remaining: def.limit - count });

    const remainingMs = (windowStart + def.windowSeconds) * 1000 - nowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    await this.deps.audit.record({
      actorType: 'anonymous',
      action: 'rate_limited',
      resourceType: 'rate_limit_rule',
      resourceId: rule,
      outcome: 'denied',
      correlationId: options.correlationId,
    });
    return err(appError('rate_limited', { retryAfterSeconds }));
  }
}
