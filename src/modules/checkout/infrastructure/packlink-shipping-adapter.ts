import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type {
  DeliveryPointProvider,
  ShippingProvider,
  ShippingQuoteRequest,
} from '../application/ports';
import {
  isValidPoint,
  isValidService,
  type DeliveryPoint,
  type ShippingService,
} from '../domain/quote';

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
 *  - `dropoff = true`: la artista deja el paquete en un punto → origen `punto`.
 *  - `dropoff = false`: recogida en su domicilio → origen `recogida`.
 *  - `delivery_to_parcelshop = true`: entrega en un punto de recogida → destino `punto`; si no,
 *    entrega a domicilio (ADR 0031).
 *  - El precio es `price.total_price` (con IVA); el plazo, `transit_hours`.
 */
export const parseService = (raw: unknown): ShippingService | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const price = r.price as Record<string, unknown> | undefined;
  const candidate = {
    id: typeof r.id === 'number' ? String(r.id) : r.id,
    name: [r.carrier_name, r.name].filter((x) => typeof x === 'string' && x !== '').join(' '),
    carrier: typeof r.carrier_name === 'string' ? r.carrier_name : '',
    modality: r.dropoff === true ? 'punto' : 'recogida',
    destination: r.delivery_to_parcelshop === true ? 'punto' : 'domicilio',
    priceCents: toCents(price?.total_price ?? r.base_price),
    transitDays: Math.ceil(Number(r.transit_hours ?? Number.NaN) / 24),
  };
  return isValidService(candidate) ? candidate : undefined;
};

/** Reduce un punto de recogida de Packlink (ADR 0031) a `DeliveryPoint`, con textos acotados. */
export const parsePoint = (raw: unknown): DeliveryPoint | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  const id = typeof r.id === 'number' ? String(r.id) : str(r.id);
  const name = str(r.commerce_name) ?? str(r.name);
  const street = str(r.address) ?? str(r.street);
  const where = [street, str(r.zip), str(r.city)].filter((x) => x !== undefined).join(', ');
  const candidate = {
    id,
    name: name?.slice(0, 120),
    address: where.slice(0, 200),
    schedule: (str(r.opening_times) ?? str(r.schedule) ?? 'Consulta el horario').slice(0, 200),
  };
  return isValidPoint(candidate) ? candidate : undefined;
};

export class PacklinkShippingAdapter implements ShippingProvider, DeliveryPointProvider {
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

  /** Puntos de recogida de destino (ADR 0031): el mismo endpoint que los puntos de origen. */
  async getDeliveryPoints(
    serviceId: string,
    postalCode: string,
  ): Promise<Result<readonly DeliveryPoint[], AppError>> {
    const url = `${this.options.baseUrl ?? DEFAULT_BASE_URL}/v1/dropoffs/${encodeURIComponent(serviceId)}/ES/${encodeURIComponent(postalCode)}`;
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
    return ok(body.map(parsePoint).filter((p): p is DeliveryPoint => p !== undefined));
  }
}
