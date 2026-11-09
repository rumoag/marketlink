import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { ShippingProvider, ShippingQuoteRequest } from '../application/ports';
import { isValidService, type ShippingService } from '../domain/quote';

export type PacklinkOptions = {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** `fetch` resiliente (tiempo de espera de 5 s, circuito y reintento solo en GET). */
  readonly fetch: typeof fetch;
};

const DEFAULT_BASE_URL = 'https://api.packlink.com';

/** Convierte euros (decimal) a centimos enteros; undefined si no es un numero finito. */
const toCents = (euros: unknown): number | undefined => {
  const n = typeof euros === 'string' ? Number(euros) : euros;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : undefined;
};

/**
 * Reduce un servicio de Packlink PRO a `ShippingService`. Contrato documentado de `GET /v1/services`;
 * los campos concretos se confirman con el spike de U0 (docs/runbooks/packlink.md).
 *  - `dropoff = true`: la artista deja el paquete en un punto → modalidad `punto`.
 *  - `dropoff = false`: recogida en su domicilio → modalidad `recogida`.
 */
export const parseService = (raw: unknown): ShippingService | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const price = r.price as Record<string, unknown> | undefined;
  const candidate = {
    id: typeof r.id === 'number' ? String(r.id) : r.id,
    name: [r.carrier_name, r.name].filter((x) => typeof x === 'string' && x !== '').join(' '),
    modality: r.dropoff === true ? 'punto' : 'recogida',
    priceCents: toCents(price?.total_price ?? r.base_price),
    transitDays: Math.ceil(Number(r.transit_hours ?? Number.NaN) / 24),
  };
  return isValidService(candidate) ? candidate : undefined;
};

export class PacklinkShippingAdapter implements ShippingProvider {
  constructor(private readonly options: PacklinkOptions) {}

  async quote(
    request: ShippingQuoteRequest,
  ): Promise<Result<readonly ShippingService[], AppError>> {
    const params = new URLSearchParams({
      'from[country]': 'ES',
      'from[zip]': request.fromPostalCode,
      'to[country]': 'ES',
      'to[zip]': request.toPostalCode,
      'packages[0][length]': String(request.parcel.lengthCm),
      'packages[0][width]': String(request.parcel.widthCm),
      'packages[0][height]': String(request.parcel.heightCm),
      'packages[0][weight]': String(request.parcel.weightKg),
      sortBy: 'totalPrice',
      source: 'PRO',
    });
    const url = `${this.options.baseUrl ?? DEFAULT_BASE_URL}/v1/services?${params.toString()}`;
    let body: unknown;
    try {
      const res = await this.options.fetch(url, {
        method: 'GET',
        headers: { Authorization: this.options.apiKey, Accept: 'application/json' },
      });
      if (!res.ok) return err(appError('dependency_unavailable'));
      body = await res.json();
    } catch {
      return err(appError('dependency_unavailable'));
    }
    if (!Array.isArray(body)) return err(appError('dependency_unavailable'));
    const services = body.map(parseService).filter((s): s is ShippingService => s !== undefined);
    return ok(services);
  }
}
