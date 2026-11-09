import {
  MAX_SHIPPING_CENTS,
  MIN_SHIPPING_CENTS,
  type Modality,
  type QuoteRef,
} from '@/modules/orders/domain/order';

/** Servicio de transporte tal como lo ofrece el proveedor, ya validado. */
export type ShippingService = {
  readonly id: string;
  readonly name: string;
  readonly modality: Modality;
  readonly priceCents: number;
  readonly transitDays: number;
};

/**
 * BR3-CT7, P-U3-19: un servicio con precio no entero, fuera de rango o con datos incompletos se
 * descarta. Si no queda ninguno, la cotizacion se trata como proveedor caido.
 */
export const isValidService = (s: unknown): s is ShippingService => {
  if (typeof s !== 'object' || s === null) return false;
  const v = s as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    v.id.length <= 120 &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    (v.modality === 'punto' || v.modality === 'recogida') &&
    typeof v.priceCents === 'number' &&
    Number.isSafeInteger(v.priceCents) &&
    v.priceCents >= MIN_SHIPPING_CENTS &&
    v.priceCents <= MAX_SHIPPING_CENTS &&
    typeof v.transitDays === 'number' &&
    Number.isFinite(v.transitDays) &&
    v.transitDays >= 0 &&
    v.transitDays <= 60
  );
};

/** Orden total y determinista (BR3-CT3): precio, luego dias de transito, luego identificador. */
export const compareServices = (a: ShippingService, b: ShippingService): number =>
  a.priceCents - b.priceCents ||
  a.transitDays - b.transitDays ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** El servicio mas barato de la modalidad pedida, o undefined si no hay (P-U3-01). */
export const selectService = (
  services: readonly ShippingService[],
  modality: Modality,
): ShippingService | undefined => {
  let best: ShippingService | undefined;
  for (const s of services) {
    if (s.modality !== modality) continue;
    if (best === undefined || compareServices(s, best) < 0) best = s;
  }
  return best;
};

export type QuoteOutcome =
  | { readonly kind: 'disponible'; readonly service: ShippingService }
  | { readonly kind: 'solo_alternativa'; readonly service: ShippingService }
  | { readonly kind: 'no_disponible' }
  | { readonly kind: 'proveedor_caido' };

const other = (m: Modality): Modality => (m === 'punto' ? 'recogida' : 'punto');

/** BR3-CT3 a CT5 (P-U3-02). `services` ya viene filtrado con `isValidService`. */
export const chooseQuoteOutcome = (
  services: readonly ShippingService[],
  listingModality: Modality,
): QuoteOutcome => {
  const main = selectService(services, listingModality);
  if (main) return { kind: 'disponible', service: main };
  const alt = selectService(services, other(listingModality));
  if (alt) return { kind: 'solo_alternativa', service: alt };
  return { kind: 'no_disponible' };
};

export const toQuoteRef = (s: ShippingService): QuoteRef => ({
  serviceId: s.id,
  serviceName: s.name,
  transitDays: s.transitDays,
  priceCents: s.priceCents,
  modality: s.modality,
});
