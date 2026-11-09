import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import { validate } from '@/modules/kernel/domain/validation';
import type { Logger } from '@/modules/platform/application/ports';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import {
  enforceLimit,
  systemScope,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import type {
  CheckoutListing,
  OperatorAlerts,
  OrdersRepos,
} from '@/modules/orders/application/ports';
import { computeTotals, type Totals } from '@/modules/orders/domain/order';
import { quotePostalSchema } from '../domain/buyer-input';
import { chooseQuoteOutcome, isValidService, type ShippingService } from '../domain/quote';
import type { ShippingProvider } from './ports';

export type QuoteState =
  | { readonly kind: 'disponible'; readonly service: ShippingService; readonly totals: Totals }
  | {
      readonly kind: 'solo_alternativa';
      readonly service: ShippingService;
      readonly totals: Totals;
    }
  | { readonly kind: 'sin_envio' };

export type QuoteResponse =
  | { readonly kind: 'cotizacion'; readonly quote: QuoteState; readonly listing: CheckoutListing }
  | { readonly kind: 'obra_no_disponible'; readonly reason: 'pausado' | 'vendido' | 'reservado' };

export type QuoteDeps = {
  readonly runner: TransactionRunner<OrdersRepos>;
  readonly shipping: ShippingProvider;
  readonly limiter: Pick<RateLimiter, 'check'>;
  readonly alerts: OperatorAlerts;
  readonly clock: Clock;
  readonly logger: Logger;
};

const ALERT_THROTTLE_MS = 15 * 60_000;

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

/**
 * Cotiza el envio de una obra a un codigo postal (US-017 a US-019). El servidor es quien consulta
 * y decide; nada de lo que llega del cliente fija el precio (BR3-CT6).
 */
export class QuoteShipping {
  private readonly throttle: AlertThrottle;

  constructor(private readonly deps: QuoteDeps) {
    this.throttle = new AlertThrottle(deps.clock);
  }

  async execute(
    slug: string,
    rawPostalCode: string,
    ip: string,
    correlationId: string,
  ): Promise<Result<QuoteResponse, AppError>> {
    const limited = await enforceLimit(this.deps.limiter, 'quote_ip', ip, {
      failClosed: true,
      correlationId,
    });
    if (!limited.ok) return limited;

    const postal = validate(quotePostalSchema, rawPostalCode);
    if (!postal.ok)
      return err(
        appError('validation', { details: [{ field: 'postalCode', reason: 'invalido' }] }),
      );

    const listing = await this.deps.runner.run(systemScope, (repos) =>
      repos.sales.findBySlug(slug),
    );
    if (!listing) return err(appError('not_found'));
    const blocked = unavailableReason(listing);
    if (blocked) return ok({ kind: 'obra_no_disponible', reason: blocked });

    const quote = await this.quoteFor(listing, postal.value, correlationId);
    return ok({ kind: 'cotizacion', quote, listing });
  }

  /** Reutilizado por StartCheckout para recotizar justo antes de cobrar (BR3-CT2). */
  async quoteFor(
    listing: CheckoutListing,
    postalCode: string,
    correlationId: string,
  ): Promise<QuoteState> {
    const res = await this.deps.shipping.quote({
      fromPostalCode: listing.sender.postalCode,
      toPostalCode: postalCode,
      parcel: listing.parcel,
      declaredValueCents: listing.declaredValueCents,
    });
    // Defensa en profundidad: aunque el adaptador ya filtra, aqui tambien se descartan basura.
    const services = res.ok ? res.value.filter(isValidService) : [];
    const outcome = res.ok ? chooseQuoteOutcome(services, listing.modality) : undefined;

    if (outcome?.kind === 'disponible' || outcome?.kind === 'solo_alternativa') {
      const totals = computeTotals(listing.priceCents, outcome.service.priceCents);
      if (totals.ok) return { kind: outcome.kind, service: outcome.service, totals: totals.value };
    }
    this.deps.logger.warn('shipping_unavailable', {
      correlationId,
      listingId: listing.id,
      providerDown: !res.ok,
    });
    if (this.throttle.allow(`${listing.id}:${postalCode}`)) {
      await this.deps.alerts.raise(
        'packlink_no_disponible',
        { listingId: listing.id, postalCode, detail: res.ok ? 'sin_servicio' : 'proveedor_caido' },
        correlationId,
      );
    }
    return { kind: 'sin_envio' };
  }
}

export const unavailableReason = (
  listing: Pick<CheckoutListing, 'status' | 'reserved'>,
): 'pausado' | 'vendido' | 'reservado' | undefined => {
  if (listing.status === 'vendido') return 'vendido';
  if (listing.status === 'pausado') return 'pausado';
  if (listing.reserved) return 'reservado';
  return undefined;
};
