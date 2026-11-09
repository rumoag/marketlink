import { err, ok, type Result } from '@/modules/kernel/domain/result';

// ---------------------------------------------------------------------------------------------
// Tamaños (BR6-TM1). La tabla `size_presets` guarda centímetros enteros y peso con 2 decimales.
// ---------------------------------------------------------------------------------------------
export type SizeInput = {
  readonly lengthCm: number;
  readonly widthCm: number;
  readonly heightCm: number;
  readonly weightKg: number;
};

export type SizeError = 'dimension_range' | 'weight_range' | 'incoherent';

export const MIN_SIDE_CM = 5;
export const MAX_SIDE_CM = 150;
export const MIN_WEIGHT_KG = 0.1;
export const MAX_WEIGHT_KG = 30;
export const MAX_GIRTH_CM = 300;

export const validateSize = (s: SizeInput): Result<SizeInput, SizeError> => {
  const sides = [s.lengthCm, s.widthCm, s.heightCm];
  if (sides.some((v) => !Number.isInteger(v) || v < MIN_SIDE_CM || v > MAX_SIDE_CM)) {
    return err('dimension_range');
  }
  if (
    !Number.isFinite(s.weightKg) ||
    s.weightKg < MIN_WEIGHT_KG ||
    s.weightKg > MAX_WEIGHT_KG ||
    Math.round(s.weightKg * 100) / 100 !== s.weightKg
  ) {
    return err('weight_range');
  }
  const [longest = 0, mid = 0, short = 0] = [...sides].sort((a, b) => b - a);
  if (longest + 2 * (mid + short) > MAX_GIRTH_CM) return err('incoherent');
  return ok(s);
};

// ---------------------------------------------------------------------------------------------
// Métricas (BR6-MT1, BR6-MT2)
// ---------------------------------------------------------------------------------------------
/** Cifras brutas de un periodo, tal como salen de las consultas agregadas. */
export type RawMetrics = {
  readonly listingsCreated: number;
  readonly views: number;
  readonly paidOrders: number;
  readonly cardOrders: number;
  readonly bizumOrders: number;
  readonly puntoOrders: number;
  readonly recogidaOrders: number;
  readonly shippingChargedCents: number;
  readonly labelCostCents: number;
  readonly ordersWithLabelCost: number;
  readonly payToLabelMsTotal: number;
  readonly payToLabelCount: number;
  readonly incidents: number;
  readonly artistsWithOrders: number;
  readonly repeatArtists: number;
};

export type Metrics = {
  readonly raw: RawMetrics;
  /** Pedidos pagados / visitas, entre 0 y 100; `undefined` sin visitas. */
  readonly conversionPct: number | undefined;
  readonly cardPct: number | undefined;
  readonly bizumPct: number | undefined;
  readonly puntoPct: number | undefined;
  readonly recogidaPct: number | undefined;
  readonly avgShippingCents: number | undefined;
  readonly avgLabelCostCents: number | undefined;
  readonly avgPayToLabelHours: number | undefined;
  /** Menos de 5 pedidos: los porcentajes tienen poca base. */
  readonly lowData: boolean;
};

export const LOW_DATA_ORDERS = 5;

const pct = (part: number, whole: number): number | undefined =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : undefined;

const avg = (total: number, count: number): number | undefined =>
  count > 0 ? Math.round(total / count) : undefined;

export const computeMetrics = (raw: RawMetrics): Metrics => {
  const methodKnown = raw.cardOrders + raw.bizumOrders;
  const conversion = pct(raw.paidOrders, raw.views);
  return {
    raw,
    // Una visita se cuenta por carga (no hay visitantes únicos): nunca pasa de 100 %.
    conversionPct: conversion === undefined ? undefined : Math.min(100, conversion),
    cardPct: pct(raw.cardOrders, methodKnown),
    bizumPct: pct(raw.bizumOrders, methodKnown),
    puntoPct: pct(raw.puntoOrders, raw.puntoOrders + raw.recogidaOrders),
    recogidaPct: pct(raw.recogidaOrders, raw.puntoOrders + raw.recogidaOrders),
    avgShippingCents: avg(raw.shippingChargedCents, raw.paidOrders),
    avgLabelCostCents: avg(raw.labelCostCents, raw.ordersWithLabelCost),
    avgPayToLabelHours:
      raw.payToLabelCount > 0
        ? Math.round((raw.payToLabelMsTotal / raw.payToLabelCount / 3_600_000) * 10) / 10
        : undefined,
    lowData: raw.paidOrders < LOW_DATA_ORDERS,
  };
};

// ---------------------------------------------------------------------------------------------
// Visitas (BR6-VS1)
// ---------------------------------------------------------------------------------------------
const BOT_PATTERN =
  /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|curl|wget|python-requests|headless/i;

export type VisitRequest = {
  readonly userAgent: string | null;
  readonly purpose: string | null;
  readonly hasArtistSession: boolean;
};

/** ¿Cuenta esta petición como visita? Sin robots evidentes, precargas ni la propia artista. */
export const countsAsVisit = (r: VisitRequest): boolean => {
  if (r.hasArtistSession) return false;
  if (r.userAgent === null || r.userAgent.trim() === '' || BOT_PATTERN.test(r.userAgent)) {
    return false;
  }
  const purpose = (r.purpose ?? '').toLowerCase();
  return !(purpose === 'prefetch' || purpose === 'preview');
};
