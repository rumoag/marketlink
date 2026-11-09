import type { AppError } from '@/modules/kernel/domain/app-error';
import type { Result } from '@/modules/kernel/domain/result';
import type { ShippingService } from '../domain/quote';

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
