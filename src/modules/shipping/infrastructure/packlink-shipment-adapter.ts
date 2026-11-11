import { splitFullName } from '../domain/names';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { instantOf, type Instant } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { DraftInput, ShipmentProvider } from '../application/ports';
import type { DropoffPoint, PickupOption, ShipmentFact } from '../domain/shipment';

export type PacklinkShipmentOptions = {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** `fetch` resiliente (5 s y un reintento en GET; el borrador usa su propio tiempo, 15 s). */
  readonly fetch: typeof fetch;
  /** `fetch` resiliente con 15 s para crear el borrador. */
  readonly writeFetch: typeof fetch;
  /** Descarga binaria de la etiqueta (la capa resiliente solo maneja texto). */
  readonly downloadFetch?: typeof fetch;
  readonly now?: () => number;
};

const DEFAULT_BASE_URL = 'https://api.packlink.com';
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_LABEL_BYTES = 2 * 1024 * 1024;

const dependency = (): AppError => appError('dependency_unavailable');

/** Defensa SSRF: la etiqueta solo se descarga de Packlink por HTTPS. */
export const isAllowedLabelUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'packlink.com' || u.hostname.endsWith('.packlink.com'))
    );
  } catch {
    return false;
  }
};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= 500 ? v : undefined;
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const list = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : obj(v) && Array.isArray(obj(v)?.data) ? (obj(v)?.data as unknown[]) : [];

/** Estados del envio en Packlink → hechos. Mapeo provisional (docs/runbooks/packlink-envios.md). */
const STATE_RANK: Readonly<Record<string, 'label_ready' | 'in_transit' | 'delivered'>> = {
  READY_FOR_COLLECTION: 'label_ready',
  LABEL_READY: 'label_ready',
  PAID: 'label_ready',
  IN_TRANSIT: 'in_transit',
  COLLECTED: 'in_transit',
  OUT_FOR_DELIVERY: 'in_transit',
  DELIVERED: 'delivered',
};

export class PacklinkShipmentAdapter implements ShipmentProvider {
  constructor(private readonly o: PacklinkShipmentOptions) {}

  private get base(): string {
    return this.o.baseUrl ?? DEFAULT_BASE_URL;
  }
  private get headers(): Record<string, string> {
    return { Authorization: this.o.apiKey, Accept: 'application/json' };
  }
  private now(): Instant {
    return instantOf(this.o.now ? this.o.now() : Date.now());
  }

  private async getJson(path: string): Promise<Result<unknown, AppError>> {
    try {
      const res = await this.o.fetch(`${this.base}${path}`, {
        method: 'GET',
        headers: this.headers,
      });
      if (!res.ok) return err(res.status === 404 ? appError('not_found') : dependency());
      return ok(await res.json());
    } catch {
      return err(dependency());
    }
  }

  async findByReference(
    reference: string,
  ): Promise<Result<{ providerRef: string } | undefined, AppError>> {
    const r = await this.getJson(
      `/v1/shipments?shipment_custom_reference=${encodeURIComponent(reference)}`,
    );
    if (!r.ok) return r.error.code === 'not_found' ? ok(undefined) : err(r.error);
    const body = obj(r.value);
    const items = Array.isArray(r.value) ? r.value : list(body?.shipments ?? body?.data ?? []);
    for (const item of items) {
      const s = obj(item);
      if (s && str(s.shipment_custom_reference) === reference) {
        const ref = str(s.reference) ?? str(s.shipment_reference);
        if (ref) return ok({ providerRef: ref });
      }
    }
    return ok(undefined);
  }

  async createDraft(input: DraftInput): Promise<Result<{ providerRef: string }, AppError>> {
    const party = (p: {
      name: string;
      street: string;
      postalCode: string;
      city: string;
      phone: string;
      email: string;
    }) => {
      const { name, surname } = splitFullName(p.name);
      return {
        name,
        surname,
        street1: p.street,
        zip_code: p.postalCode,
        city: p.city,
        country: 'ES',
        phone: p.phone,
        email: p.email,
      };
    };
    const body = {
      from: party({
        name: input.sender.name,
        street: `${input.sender.street} ${input.sender.number}${input.sender.floorDoor ? ` ${input.sender.floorDoor}` : ''}`,
        postalCode: input.sender.postalCode,
        city: input.sender.city,
        phone: input.sender.phone,
        email: input.sender.email,
      }),
      to: party({
        name: input.recipient.name,
        street: `${input.recipient.street}${input.recipient.complement ? ` ${input.recipient.complement}` : ''}`,
        postalCode: input.recipient.postalCode,
        city: input.recipient.city,
        phone: input.recipient.phone,
        email: input.recipient.email,
      }),
      packages: [
        {
          length: input.parcel.lengthCm,
          width: input.parcel.widthCm,
          height: input.parcel.heightCm,
          weight: input.parcel.weightKg,
        },
      ],
      service_id: input.serviceId,
      ...(input.recipient.pointId ? { dropoff_point_id: input.recipient.pointId } : {}),
      content: 'Obra de arte',
      contentvalue: input.declaredValueCents / 100,
      shipment_custom_reference: input.reference,
      ...(input.pickup
        ? { collection_date: input.pickup.date, collection_time: input.pickup.slot }
        : {}),
    };
    try {
      const res = await this.o.writeFetch(`${this.base}/v1/shipments`, {
        method: 'POST',
        headers: {
          ...this.headers,
          'Content-Type': 'application/json',
          'Idempotency-Key': `shipment:${input.reference}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        return err(res.status >= 500 || res.status === 429 ? dependency() : appError('validation'));
      const json = obj(await res.json());
      const ref = str(json?.reference) ?? str(json?.shipment_reference);
      return ref ? ok({ providerRef: ref }) : err(dependency());
    } catch {
      return err(dependency());
    }
  }

  async fetchFacts(providerRef: string): Promise<Result<readonly ShipmentFact[], AppError>> {
    const r = await this.getJson(`/v1/shipments/${encodeURIComponent(providerRef)}`);
    if (!r.ok) return err(r.error);
    const s = obj(r.value);
    if (!s) return err(dependency());
    const at = this.now();
    const state = (str(s.state) ?? str(s.status) ?? '').toUpperCase();
    const price =
      typeof s.price === 'number'
        ? s.price
        : obj(s.price)
          ? Number(obj(s.price)?.total_price)
          : undefined;
    const info = {
      trackingUrl: str(s.carrier_tracking_url) ?? str(s.tracking_url),
      trackingCode: str(s.carrier_tracking_number) ?? str(s.tracking_code),
      labelCostCents:
        price !== undefined && Number.isFinite(price) && price >= 0
          ? Math.round(price * 100)
          : undefined,
    };
    const facts: ShipmentFact[] = [{ type: 'tracking_info', at, ...info }];
    if (/FAIL|ERROR|INCIDENT/.test(state)) {
      facts.push({ type: state.includes('LABEL') ? 'label_failed' : 'carrier_failed', at });
      return ok(facts);
    }
    const target = STATE_RANK[state];
    if (target) {
      facts.push({ type: 'label_ready', at });
      if (target === 'in_transit' || target === 'delivered') facts.push({ type: 'in_transit', at });
      if (target === 'delivered') facts.push({ type: 'delivered', at });
    }
    return ok(facts);
  }

  async getLabel(providerRef: string): Promise<Result<Uint8Array, AppError>> {
    const r = await this.getJson(`/v1/shipments/${encodeURIComponent(providerRef)}/labels`);
    if (!r.ok) return err(r.error);
    const first = list(r.value).find((x): x is string => typeof x === 'string');
    if (!first || !isAllowedLabelUrl(first)) return err(dependency());
    try {
      const dl = this.o.downloadFetch ?? fetch;
      const res = await dl(first, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!res.ok) return err(dependency());
      const bytes = new Uint8Array(await res.arrayBuffer());
      const isPdf =
        bytes.length > 4 &&
        bytes[0] === 0x25 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x44 &&
        bytes[3] === 0x46;
      if (!isPdf || bytes.length > MAX_LABEL_BYTES) return err(appError('validation'));
      return ok(bytes);
    } catch {
      return err(dependency());
    }
  }

  async getDropoffs(
    serviceId: string,
    postalCode: string,
  ): Promise<Result<readonly DropoffPoint[], AppError>> {
    const r = await this.getJson(
      `/v1/dropoffs/${encodeURIComponent(serviceId)}/ES/${encodeURIComponent(postalCode)}`,
    );
    if (!r.ok) return err(r.error);
    const points: DropoffPoint[] = [];
    for (const item of list(r.value)) {
      const p = obj(item);
      const name = str(p?.commerce_name) ?? str(p?.name);
      const address = str(p?.address) ?? [str(p?.street), str(p?.city)].filter(Boolean).join(', ');
      if (!p || !name || !address) continue;
      const dist =
        typeof p.distance === 'number' && Number.isFinite(p.distance) ? p.distance : undefined;
      points.push({
        name,
        address,
        schedule: str(p.opening_times) ?? str(p.schedule) ?? 'Consulta el horario',
        distanceKm: dist,
      });
    }
    return ok(points);
  }

  async getPickupOptions(
    serviceId: string,
    postalCode: string,
  ): Promise<Result<readonly PickupOption[], AppError>> {
    const r = await this.getJson(
      `/v1/services/${encodeURIComponent(serviceId)}/pickup-dates?zip=${encodeURIComponent(postalCode)}`,
    );
    if (!r.ok) return err(r.error);
    const options: PickupOption[] = [];
    const add = (date: unknown, slot: unknown) => {
      const d = str(date);
      const s = str(slot);
      if (d && s && /^\d{4}-\d{2}-\d{2}$/.test(d))
        options.push({ id: `${d}|${s}`, date: d, slot: s });
    };
    const body = obj(r.value);
    if (Array.isArray(r.value)) {
      for (const item of r.value) {
        const o = obj(item);
        for (const slot of Array.isArray(o?.slots) ? (o?.slots as unknown[]) : [o?.slot])
          add(o?.date, slot);
      }
    } else if (body) {
      for (const [date, slots] of Object.entries(body)) {
        for (const slot of Array.isArray(slots) ? slots : []) add(date, slot);
      }
    }
    return ok(options.slice(0, 30));
  }
}
