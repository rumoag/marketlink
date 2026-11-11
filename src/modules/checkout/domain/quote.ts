import {
  MAX_SHIPPING_CENTS,
  type DeliveryPointRef,
  MIN_SHIPPING_CENTS,
  type Modality,
  type QuoteRef,
} from '@/modules/orders/domain/order';

/** Punto de recogida de destino (BR8-PT). */
export type DeliveryPoint = DeliveryPointRef;

/** Servicio de transporte tal como lo ofrece el proveedor, ya validado. */
export type ShippingService = {
  readonly id: string;
  readonly name: string;
  readonly carrier: string;
  /** Origen: lo que hace la artista (llevar a un punto o que la recojan). */
  readonly modality: Modality;
  /** Destino: lo que recibe el comprador (a domicilio o en un punto). */
  readonly destination: 'domicilio' | 'punto';
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
    v.name.length <= 120 &&
    typeof v.carrier === 'string' &&
    v.carrier.length > 0 &&
    v.carrier.length <= 60 &&
    (v.destination === 'domicilio' || v.destination === 'punto') &&
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

export type DeliveryGroups = {
  readonly domicilio: readonly ShippingService[];
  readonly punto: readonly ShippingService[];
};

export type DeliveryOptions = {
  /** Todos los servicios compatibles, ordenados (precio, plazo, id). */
  readonly groups: DeliveryGroups;
  /** Hasta 3 por grupo, en orden de precio ascendente. */
  readonly highlights: DeliveryGroups;
  /** Opcion marcada por defecto (BR8-S8). */
  readonly preselected: ShippingService | undefined;
};

/** BR8-S1, BR8-O4: solo los servicios cuyo origen acepta la artista. */
export const acceptedServices = (
  services: readonly ShippingService[],
  origins: ReadonlySet<Modality>,
): ShippingService[] => services.filter((s) => origins.has(s.modality));

/** BR8-S2: particion por destino, cada grupo con el orden total de `compareServices`. */
export const groupByDestination = (services: readonly ShippingService[]): DeliveryGroups => {
  const sorted = [...services].sort(compareServices);
  return {
    domicilio: sorted.filter((s) => s.destination === 'domicilio'),
    punto: sorted.filter((s) => s.destination === 'punto'),
  };
};

const compareBySpeed = (a: ShippingService, b: ShippingService): number =>
  a.transitDays - b.transitDays || compareServices(a, b);

/**
 * BR8-S3 a S6: la mas barata, la mas rapida y una intermedia (la de menor precio entre las que llegan
 * antes que la mas barata; si ninguna, la segunda mas barata). Distintas, hasta `max`, completando con
 * las siguientes mas baratas, y devueltas por precio ascendente.
 */
export const pickHighlights = (group: readonly ShippingService[], max = 3): ShippingService[] => {
  const sorted = [...group].sort(compareServices);
  const cheapest = sorted[0];
  if (cheapest === undefined) return [];
  const fastest = [...sorted].sort(compareBySpeed)[0] as ShippingService;
  const chosen = new Map<string, ShippingService>();
  chosen.set(cheapest.id, cheapest);
  chosen.set(fastest.id, fastest);
  const rest = sorted.filter((s) => !chosen.has(s.id));
  const earlier = rest.filter((s) => s.transitDays < cheapest.transitDays);
  const middle = earlier[0] ?? rest[0];
  if (middle !== undefined) chosen.set(middle.id, middle);
  for (const s of sorted) {
    if (chosen.size >= max) break;
    if (!chosen.has(s.id)) chosen.set(s.id, s);
  }
  return [...chosen.values()].sort(compareServices).slice(0, max);
};

/** BR8-S8: la mas barata de las destacadas a domicilio; si no hay, la de punto. */
export const defaultOption = (highlights: DeliveryGroups): ShippingService | undefined =>
  highlights.domicilio[0] ?? highlights.punto[0];

/** Funcion pura y determinista (P-U8-09): no depende del orden de entrada. */
export const buildOptions = (
  services: readonly ShippingService[],
  origins: ReadonlySet<Modality>,
): DeliveryOptions => {
  const groups = groupByDestination(acceptedServices(services, origins));
  const highlights: DeliveryGroups = {
    domicilio: pickHighlights(groups.domicilio),
    punto: pickHighlights(groups.punto),
  };
  return { groups, highlights, preselected: defaultOption(highlights) };
};

/** Busca un servicio por identificador entre las opciones compatibles (BR8-V1). */
export const findOption = (
  options: DeliveryOptions,
  serviceId: string,
): ShippingService | undefined =>
  options.groups.domicilio.find((s) => s.id === serviceId) ??
  options.groups.punto.find((s) => s.id === serviceId);

export const toQuoteRef = (s: ShippingService): QuoteRef => ({
  serviceId: s.id,
  serviceName: s.name,
  transitDays: s.transitDays,
  priceCents: s.priceCents,
  modality: s.modality,
  carrier: s.carrier,
  destination: s.destination,
});

export const isValidPoint = (p: unknown): p is DeliveryPoint => {
  if (typeof p !== 'object' || p === null) return false;
  const v = p as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(v.id) &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    v.name.length <= 120 &&
    typeof v.address === 'string' &&
    v.address.length > 0 &&
    v.address.length <= 200 &&
    typeof v.schedule === 'string' &&
    v.schedule.length <= 200
  );
};

export type SelectionCheck =
  | {
      readonly kind: 'ok';
      readonly service: ShippingService;
      readonly point: DeliveryPoint | undefined;
    }
  | { readonly kind: 'servicio_no_disponible' }
  | { readonly kind: 'punto_no_disponible'; readonly service: ShippingService }
  | { readonly kind: 'seleccion_invalida' };

/**
 * BR8-V1 a V4 (P-U8-08): el servicio debe estar entre las opciones; con destino punto, el punto debe
 * estar en la lista actual (`points`, `undefined` si no se ha podido obtener); con domicilio no hay punto.
 */
export const checkSelection = (
  options: DeliveryOptions,
  serviceId: string,
  pointId: string | undefined,
  points: readonly DeliveryPoint[] | undefined,
): SelectionCheck => {
  const service = findOption(options, serviceId);
  if (service === undefined) return { kind: 'servicio_no_disponible' };
  if (service.destination === 'domicilio') {
    return pointId === undefined || pointId === ''
      ? { kind: 'ok', service, point: undefined }
      : { kind: 'seleccion_invalida' };
  }
  if (pointId === undefined || pointId === '') return { kind: 'seleccion_invalida' };
  const point = points?.find((p) => p.id === pointId);
  return point === undefined
    ? { kind: 'punto_no_disponible', service }
    : { kind: 'ok', service, point };
};
