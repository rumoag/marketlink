import { addMs, MS, type Clock, type Random } from '@/modules/kernel/domain/clock';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import { CircuitBreaker, type CircuitConfig } from '../domain/circuit-breaker';
import type { Logger } from '../application/ports';

export type ProviderName = 'stripe' | 'packlink' | 'resend' | 'supabase';

export type HttpRequest = {
  readonly provider: ProviderName;
  readonly operation: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  /** Clave de idempotencia: permite reintentar metodos no idempotentes (BR-H2). */
  readonly idempotencyKey?: string;
  readonly timeoutMs?: number;
  /** Reintentos maximos (por defecto 2); nunca mas que los tiempos de espera definidos. */
  readonly maxRetries?: number;
  readonly correlationId?: string;
};

export type HttpResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type HttpClientDeps = {
  readonly fetch?: FetchLike;
  readonly clock: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger: Logger;
  readonly random?: Random;
  readonly circuitConfig?: CircuitConfig;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TOTAL_MS = 30_000;
const RETRY_WAITS_MS = [200, 800] as const;
const MAX_RETRY_AFTER_MS = 5_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cliente HTTP resiliente (BR-H1 a BR-H5): tiempo de espera, reintentos acotados en operaciones
 * idempotentes y un interruptor de circuito por proveedor. Registra cada intento sin cuerpos,
 * cabeceras de autorizacion ni parametros de consulta.
 */
export class ResilientHttpClient {
  private readonly breakers = new Map<ProviderName, CircuitBreaker>();
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: HttpClientDeps) {
    this.doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = deps.sleep ?? defaultSleep;
  }

  circuit(provider: ProviderName): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new CircuitBreaker(this.deps.clock, this.deps.circuitConfig);
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  async request(req: HttpRequest): Promise<Result<HttpResponse, AppError>> {
    const breaker = this.circuit(req.provider);
    const idempotent = req.method === 'GET' || req.idempotencyKey !== undefined;
    const maxRetries = idempotent
      ? Math.min(req.maxRetries ?? RETRY_WAITS_MS.length, RETRY_WAITS_MS.length)
      : 0;
    const startedAt = this.deps.clock.now();
    const path = safePath(req.url);
    const headers = {
      ...(req.headers ?? {}),
      ...(req.idempotencyKey ? { 'Idempotency-Key': req.idempotencyKey } : {}),
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (!breaker.tryAcquire()) {
        this.deps.logger.warn('http_call_rejected_circuit_open', {
          provider: req.provider,
          operation: req.operation,
          correlationId: req.correlationId,
        });
        return err(appError('dependency_unavailable'));
      }

      const callStart = this.deps.clock.now();
      let status: number | undefined;
      let response: HttpResponse | undefined;
      let failureKind: 'network' | 'timeout' | 'status' | undefined;

      try {
        const init: RequestInit = {
          method: req.method,
          headers,
          signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          redirect: 'manual',
          ...(req.body !== undefined ? { body: req.body as BodyInit } : {}),
        };
        const res = await this.doFetch(req.url, init);
        status = res.status;
        response = { status: res.status, headers: res.headers, body: await res.text() };
        if (status >= 500 || status === 429) failureKind = 'status';
      } catch (e) {
        failureKind = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network';
      }

      const durationMs = this.deps.clock.now() - callStart;
      this.deps.logger.info('http_call', {
        provider: req.provider,
        operation: req.operation,
        method: req.method,
        path,
        status,
        durationMs,
        attempt: attempt + 1,
        outcome: failureKind ?? 'ok',
        correlationId: req.correlationId,
      });

      // BR-C2: red, tiempo de espera, 5xx y 429 cuentan como fallo; el resto de 4xx no.
      if (failureKind === undefined && response !== undefined) {
        breaker.recordSuccess();
        return ok(response);
      }
      breaker.recordFailure();

      if (attempt >= maxRetries) break;

      const wait = this.waitFor(attempt, status, response?.headers);
      if (wait === undefined) break; // Retry-After demasiado largo (BR-H3)
      const elapsed = this.deps.clock.now() - startedAt;
      if (addMs(startedAt, elapsed + wait) - startedAt > MAX_TOTAL_MS) break;
      await this.sleep(wait);
    }

    return err(appError('dependency_unavailable'));
  }

  private waitFor(
    attempt: number,
    status: number | undefined,
    headers?: Headers,
  ): number | undefined {
    const base = RETRY_WAITS_MS[attempt] ?? RETRY_WAITS_MS[RETRY_WAITS_MS.length - 1] ?? 800;
    if (status !== 429) return base;
    const raw = headers?.get('retry-after');
    if (raw === null || raw === undefined) return base;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return base;
    const ms = seconds * MS.second;
    return ms > MAX_RETRY_AFTER_MS ? undefined : Math.max(ms, base);
  }
}

/** Ruta sin parametros de consulta ni fragmento (BR-H4). */
export const safePath = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return '(invalida)';
  }
};
