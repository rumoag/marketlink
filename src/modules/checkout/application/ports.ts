import type { AppError } from '@/modules/kernel/domain/app-error';
import type { Result } from '@/modules/kernel/domain/result';
import type { Instant } from '@/modules/kernel/domain/clock';
import type { DeliveryPoint, ShippingService } from '../domain/quote';

export type ShippingQuoteRequest = {
  readonly fromPostalCode: string;
  readonly toPostalCode: string;
  readonly parcel: {
    readonly lengthCm: number;
    readonly widthCm: number;
    readonly heightCm: number;
    readonly weightKg: number;
  };
  readonly declaredValueCents: number;
};

/**
 * Cotizacion de transporte (Packlink). Devuelve solo servicios ya validados con `isValidService`;
 * un error significa «proveedor caido» (tiempo de espera, circuito abierto o respuesta invalida).
 */
export interface ShippingProvider {
  quote(request: ShippingQuoteRequest): Promise<Result<readonly ShippingService[], AppError>>;
}

/** U8: puntos de recogida de destino para un servicio y un codigo postal (ADR 0031). */
export interface DeliveryPointProvider {
  getDeliveryPoints(
    serviceId: string,
    postalCode: string,
  ): Promise<Result<readonly DeliveryPoint[], AppError>>;
}

/**
 * U8: cache compartida de respuestas de proveedor con caducidad (ADR 0033). Sin datos personales.
 * `get` nunca devuelve una entrada caducada (NFR-U8-16). Un fallo aqui no impide operar (NFR-U8-17).
 */
export interface ProviderCache {
  get(key: string, now: Instant): Promise<unknown>;
  set(key: string, value: unknown, ttlMs: number, now: Instant): Promise<void>;
}
