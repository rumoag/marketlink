import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { Logger } from '@/modules/platform/application/ports';
import type { CheckoutListing, OperatorAlerts } from '@/modules/orders/application/ports';
import {
  isValidPoint,
  isValidService,
  type DeliveryPoint,
  type ShippingService,
} from '../domain/quote';
import type { DeliveryPointProvider, ProviderCache, ShippingProvider } from './ports';

const ALERT_THROTTLE_MS = 15 * 60_000;
const MAX_POINTS = 30;

/** Throttle de avisos por (enlace, codigo postal): un aviso cada 15 minutos por instancia (BR3-CT5). */
export class AlertThrottle {
  private readonly last = new Map<string, number>();
  constructor(private readonly clock: Clock) {}

  allow(key: string): boolean {
    const now = this.clock.now();
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < ALERT_THROTTLE_MS) return false;
    if (this.last.size > 1_000) this.last.clear();
    this.last.set(key, now);
    return true;
  }
}

export type ShippingOptionsDeps = {
  readonly shipping: ShippingProvider;
  readonly points: DeliveryPointProvider;
  readonly cache: ProviderCache;
  readonly alerts: OperatorAlerts;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Caducidad de la cache (QUOTE_CACHE_TTL_MINUTES, NFR-U8-11). */
  readonly cacheTtlMs: number;
};

/** Datos que determinan el precio: si cambian, la clave de cache cambia (no hay datos personales). */
/** Lo minimo de una obra para cotizar: origen, bulto y valor declarado. */
export type QuoteSubject = {
  readonly sender: { readonly postalCode: string };
  readonly parcel: CheckoutListing['parcel'];
  readonly declaredValueCents: number;
};

const quoteKey = (listing: QuoteSubject, toPostalCode: string): string =>
  [
    'quote',
    listing.sender.postalCode,
    toPostalCode,
    `${listing.parcel.lengthCm}x${listing.parcel.widthCm}x${listing.parcel.heightCm}`,
    listing.parcel.weightKg,
    listing.declaredValueCents,
  ].join(':');

/**
 * Servicios y puntos de Packlink con cache compartida (EN-17). Nunca usa una entrada caducada
 * (NFR-U8-16): con la cache vencida y Packlink caido devuelve `dependency_unavailable`.
 */
export class ShippingOptionsFinder {
  private readonly throttle: AlertThrottle;

  constructor(private readonly deps: ShippingOptionsDeps) {
    this.throttle = new AlertThrottle(deps.clock);
  }

  /** Todos los servicios validos del enlace al codigo postal (sin filtrar por origen). */
  async services(
    listing: QuoteSubject,
    postalCode: string,
    correlationId: string,
  ): Promise<Result<readonly ShippingService[], AppError>> {
    const { deps } = this;
    const key = quoteKey(listing, postalCode);
    const cached = await this.read(key, correlationId);
    if (Array.isArray(cached)) {
      const services = cached.filter(isValidService);
      if (services.length > 0) {
        deps.logger.info('options_computed', {
          correlationId,
          cache: 'hit',
          services: services.length,
        });
        return ok(services);
      }
    }
    const started = deps.clock.now();
    const res = await deps.shipping.quote({
      fromPostalCode: listing.sender.postalCode,
      toPostalCode: postalCode,
      parcel: listing.parcel,
      declaredValueCents: listing.declaredValueCents,
    });
    // Defensa en profundidad: aunque el adaptador ya filtra, aqui tambien se descarta basura.
    const services = res.ok ? res.value.filter(isValidService) : [];
    deps.logger.info('options_computed', {
      correlationId,
      cache: 'miss',
      services: services.length,
      ms: deps.clock.now() - started,
    });
    if (!res.ok) return err(res.error);
    if (services.length > 0) await this.write(key, services, correlationId);
    return ok(services);
  }

  /** Puntos de recogida de un servicio con destino punto (maximo 30, ya validados). */
  async points(
    serviceId: string,
    postalCode: string,
    correlationId: string,
  ): Promise<Result<readonly DeliveryPoint[], AppError>> {
    const { deps } = this;
    const key = `points:${serviceId}:${postalCode}`;
    const cached = await this.read(key, correlationId);
    if (Array.isArray(cached)) {
      const points = cached.filter(isValidPoint);
      if (points.length > 0) return ok(points);
    }
    const res = await deps.points.getDeliveryPoints(serviceId, postalCode);
    if (!res.ok) return err(res.error);
    const points = res.value.filter(isValidPoint).slice(0, MAX_POINTS);
    deps.logger.info('points_listed', { correlationId, count: points.length });
    if (points.length > 0) await this.write(key, points, correlationId);
    return ok(points);
  }

  /** Avisa al operador (con limite de frecuencia) de que no hay envio posible o Packlink esta caido. */
  async reportUnavailable(
    listing: CheckoutListing,
    postalCode: string,
    providerDown: boolean,
    correlationId: string,
  ): Promise<void> {
    this.deps.logger.warn('shipping_unavailable', {
      correlationId,
      listingId: listing.id,
      providerDown,
    });
    if (!this.throttle.allow(`${listing.id}:${postalCode}`)) return;
    await this.deps.alerts.raise(
      'packlink_no_disponible',
      {
        listingId: listing.id,
        postalCode,
        detail: providerDown ? 'proveedor_caido' : 'sin_servicio',
      },
      correlationId,
    );
  }

  private async read(key: string, correlationId: string): Promise<unknown> {
    try {
      return await this.deps.cache.get(key, this.deps.clock.now());
    } catch {
      this.deps.logger.warn('provider_cache_error', { correlationId, op: 'get' });
      return undefined;
    }
  }

  private async write(key: string, value: unknown, correlationId: string): Promise<void> {
    try {
      await this.deps.cache.set(key, value, this.deps.cacheTtlMs, this.deps.clock.now());
    } catch {
      this.deps.logger.warn('provider_cache_error', { correlationId, op: 'set' });
    }
  }
}

export const providerDown = (): AppError => appError('dependency_unavailable');
