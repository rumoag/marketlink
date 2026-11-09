import { instantOf, type Instant } from '@/modules/kernel/domain/clock';
import type { FactType, ShipmentFact } from './shipment';

/** Un evento de Packlink ya reducido: a que envio pertenece, su identificador y el hecho. */
export type ProviderEvent = {
  readonly eventId: string;
  readonly providerRef: string;
  readonly fact: ShipmentFact;
};

const KNOWN: Readonly<Record<string, FactType>> = {
  'shipment.label.ready': 'label_ready',
  'shipment.carrier.success': 'in_transit',
  'shipment.delivered': 'delivered',
  'shipment.carrier.delivered': 'delivered',
  'shipment.label.fail': 'label_failed',
  'shipment.carrier.fail': 'carrier_failed',
  'shipment.tracking.update': 'tracking_info',
};

const IN_TRANSIT = new Set(['IN_TRANSIT', 'COLLECTED', 'PICKED_UP', 'OUT_FOR_DELIVERY']);
const DELIVERED = new Set(['DELIVERED']);

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= 500 ? v : undefined;

/** Marca de tiempo del proveedor en segundos, milisegundos o ISO; si falta, la de recepcion. */
const toInstant = (v: unknown, fallback: Instant): Instant => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return instantOf(v < 1e11 ? Math.round(v * 1000) : Math.round(v));
  }
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return instantOf(ms);
  }
  return fallback;
};

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * Reduce el cuerpo de un webhook de Packlink a un hecho (P-U4-05). Total: nunca lanza; devuelve
 * `undefined` para eventos desconocidos o sin referencia de envio. La forma exacta del cuerpo se
 * confirma con el spike de U0 (docs/runbooks/packlink-envios.md); aqui se lee de forma tolerante.
 */
export const reduceProviderEvent = (
  body: unknown,
  receivedAt: Instant,
): ProviderEvent | undefined => {
  const root = obj(body);
  if (!root) return undefined;
  const data = obj(root.data) ?? {};
  const name = str(root.event) ?? str(root.type) ?? str(root.name);
  if (!name) return undefined;
  const base = KNOWN[name];
  if (!base) return undefined;

  const providerRef =
    str(data.shipment_reference) ??
    str(data.reference) ??
    str(root.shipment_reference) ??
    str(root.reference) ??
    str(data.id) ??
    str(root.shipment_id);
  if (!providerRef) return undefined;

  const at = toInstant(
    root.created_at ?? root.timestamp ?? data.timestamp ?? data.created_at,
    receivedAt,
  );
  const status = str(data.status)?.toUpperCase();
  let type: FactType = base;
  if (base === 'tracking_info' && status) {
    if (DELIVERED.has(status)) type = 'delivered';
    else if (IN_TRANSIT.has(status)) type = 'in_transit';
  }
  const price = typeof data.price === 'number' ? data.price : undefined;
  const fact: ShipmentFact = {
    type,
    at,
    trackingUrl: str(data.tracking_url) ?? str(data.carrier_tracking_url),
    trackingCode: str(data.tracking_code) ?? str(data.carrier_tracking_number),
    labelCostCents:
      price !== undefined && Number.isFinite(price) && price >= 0
        ? Math.round(price * 100)
        : undefined,
  };
  const eventId = str(root.id) ?? str(root.event_id) ?? `${name}:${providerRef}:${at}`;
  return { eventId, providerRef, fact };
};
