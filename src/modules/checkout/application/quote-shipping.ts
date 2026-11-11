import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import { validate } from '@/modules/kernel/domain/validation';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import {
  enforceLimit,
  systemScope,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import type { CheckoutListing, OrdersRepos } from '@/modules/orders/application/ports';
import { quotePostalSchema } from '../domain/buyer-input';
import {
  buildOptions,
  findOption,
  type DeliveryOptions,
  type DeliveryPoint,
} from '../domain/quote';
import type { ShippingOptionsFinder } from './shipping-options';

export type OptionsResponse =
  | {
      readonly kind: 'opciones';
      readonly options: DeliveryOptions;
      readonly listing: CheckoutListing;
    }
  | { readonly kind: 'sin_envio' }
  | { readonly kind: 'obra_no_disponible'; readonly reason: 'pausado' | 'vendido' | 'reservado' };

export type QuoteOptionsDeps = {
  readonly runner: TransactionRunner<OrdersRepos>;
  readonly finder: ShippingOptionsFinder;
  readonly limiter: Pick<RateLimiter, 'check'>;
};

export const unavailableReason = (
  listing: Pick<CheckoutListing, 'status' | 'reserved'>,
): 'pausado' | 'vendido' | 'reservado' | undefined => {
  if (listing.status === 'vendido') return 'vendido';
  if (listing.status === 'pausado') return 'pausado';
  if (listing.reserved) return 'reservado';
  return undefined;
};

/** Origenes que la artista acepta para este enlace (BR8-O4). */
export const originsOf = (listing: CheckoutListing): ReadonlySet<'punto' | 'recogida'> =>
  new Set(listing.origins);

/**
 * U8 (sustituye a QuoteShipping): opciones de entrega de una obra a un codigo postal (US-056 a US-063).
 * El servidor es quien consulta y decide; nada de lo que llega del cliente fija el precio.
 */
export class QuoteOptions {
  constructor(private readonly deps: QuoteOptionsDeps) {}

  async execute(
    slug: string,
    rawPostalCode: string,
    ip: string,
    correlationId: string,
  ): Promise<Result<OptionsResponse, AppError>> {
    const limited = await enforceLimit(this.deps.limiter, 'options_ip', ip, {
      failClosed: true,
      correlationId,
    });
    if (!limited.ok) return limited;

    const postal = validate(quotePostalSchema, rawPostalCode);
    if (!postal.ok) {
      return err(
        appError('validation', { details: [{ field: 'postalCode', reason: 'invalido' }] }),
      );
    }
    const listing = await this.deps.runner.run(systemScope, (repos) =>
      repos.sales.findBySlug(slug),
    );
    if (!listing) return err(appError('not_found'));
    const blocked = unavailableReason(listing);
    if (blocked) return ok({ kind: 'obra_no_disponible', reason: blocked });

    const services = await this.deps.finder.services(listing, postal.value, correlationId);
    if (!services.ok) {
      await this.deps.finder.reportUnavailable(listing, postal.value, true, correlationId);
      return err(services.error);
    }
    const options = buildOptions(services.value, originsOf(listing));
    if (options.preselected === undefined) {
      await this.deps.finder.reportUnavailable(listing, postal.value, false, correlationId);
      return ok({ kind: 'sin_envio' });
    }
    return ok({ kind: 'opciones', options, listing });
  }
}

export type ListPointsDeps = QuoteOptionsDeps;

/** US-060: puntos de recogida de un servicio de las opciones del enlace, para un codigo postal. */
export class ListDeliveryPoints {
  constructor(private readonly deps: ListPointsDeps) {}

  async execute(
    slug: string,
    rawPostalCode: string,
    rawServiceId: string,
    ip: string,
    correlationId: string,
  ): Promise<Result<readonly DeliveryPoint[], AppError>> {
    const limited = await enforceLimit(this.deps.limiter, 'points_ip', ip, {
      failClosed: true,
      correlationId,
    });
    if (!limited.ok) return limited;

    const postal = validate(quotePostalSchema, rawPostalCode);
    if (!postal.ok || !/^\d{1,10}$/.test(rawServiceId)) {
      return err(appError('validation'));
    }
    const listing = await this.deps.runner.run(systemScope, (repos) =>
      repos.sales.findBySlug(slug),
    );
    if (!listing) return err(appError('not_found'));
    if (unavailableReason(listing)) return err(appError('conflict'));

    const services = await this.deps.finder.services(listing, postal.value, correlationId);
    if (!services.ok) return err(services.error);
    const service = findOption(buildOptions(services.value, originsOf(listing)), rawServiceId);
    if (service === undefined || service.destination !== 'punto') {
      return err(appError('validation', { details: [{ field: 'serviceId', reason: 'invalido' }] }));
    }
    return this.deps.finder.points(rawServiceId, postal.value, correlationId);
  }
}
