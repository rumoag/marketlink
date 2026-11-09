import type { ProviderName, ResilientHttpClient } from './http-client';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const toBody = (body: RequestInit['body']): string | Uint8Array | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return body.toString();
  // FormData, Blob y streams no se admiten: los SDK se configuran para no usarlos.
  throw new TypeError('unsupported_body');
};

/**
 * Adapta el cliente resiliente a la firma de `fetch` que aceptan los SDK de Supabase y de Stripe
 * (P2-WH-2): tiempo de espera, circuito por proveedor y registro sin cuerpos ni cabeceras de
 * autorizacion. Un fallo definitivo se lanza como error de red, que los SDK ya saben tratar.
 */
export const createResilientFetch = (
  client: ResilientHttpClient,
  provider: ProviderName,
  operation = 'sdk',
  /** Ajuste por proveedor (p. ej. Packlink: 5 s y un reintento, NFR-U3-02). */
  tuning: { readonly timeoutMs?: number; readonly maxRetries?: number } = {},
): typeof fetch => {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!METHODS.includes(method)) throw new TypeError('unsupported_method');

    // La clave de idempotencia pasa a ser un campo del cliente para habilitar reintentos seguros.
    const headers: Record<string, string> = {};
    let idempotencyKey: string | undefined;
    new Headers(init?.headers).forEach((value, name) => {
      if (name.toLowerCase() === 'idempotency-key') idempotencyKey = value;
      else headers[name] = value;
    });

    const body = toBody(init?.body);
    const result = await client.request({
      provider,
      operation,
      method: method as Method,
      url,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(tuning.timeoutMs !== undefined ? { timeoutMs: tuning.timeoutMs } : {}),
      ...(tuning.maxRetries !== undefined ? { maxRetries: tuning.maxRetries } : {}),
    });
    if (!result.ok) throw new TypeError('dependency_unavailable');

    return new Response(result.value.body, {
      status: result.value.status,
      headers: result.value.headers,
    });
  };
};
