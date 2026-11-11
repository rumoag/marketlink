import { z } from 'zod';
import type { Instant } from '@/modules/kernel/domain/clock';
import { listingPriceSchema } from '@/modules/kernel/domain/schemas';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { Slug } from './slug';
import { isValidDescription, isValidTitle, normalizeDescription, normalizeTitle } from './text';

export const LISTING_STATUSES = ['activo', 'pausado', 'vendido'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export type PausedReason = 'artista' | 'cobros_restringidos';
export type PackageSize = 'S' | 'M' | 'L';
export type Modality = 'punto' | 'recogida';

/** U8 (BR8-O1): orden canonico y sin repetidos; al menos un origen. */
export const normalizeOrigins = (origins: readonly Modality[]): Modality[] => {
  const out: Modality[] = [];
  if (origins.includes('punto')) out.push('punto');
  if (origins.includes('recogida')) out.push('recogida');
  return out;
};

/** Compatibilidad con la columna antigua `modality`: punto si se acepta, si no recogida. */
export const modalityOf = (origins: readonly Modality[]): Modality =>
  origins.includes('punto') ? 'punto' : 'recogida';

/** BR2-LK3: maximo de enlaces activos o pausados por artista (configurable). */
export const MAX_OPEN_LISTINGS = 20;

export type Listing = {
  readonly id: string;
  readonly artistId: string;
  readonly slug: Slug;
  readonly title: string;
  readonly description: string;
  readonly priceCents: number;
  readonly declaredValueCents: number;
  readonly fragile: boolean;
  readonly size: PackageSize;
  /** Derivada de `origins` (compatibilidad con U2 a U7). */
  readonly modality: Modality;
  /** U8: origenes que la artista acepta (BR8-O1). */
  readonly origins: readonly Modality[];
  readonly status: ListingStatus;
  readonly pausedReason: PausedReason | undefined;
  readonly orderId: string | undefined;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly soldAt: Instant | undefined;
};

export type ListingError =
  | 'sold' // BR2-LK4, BR2-ED1: vendido es terminal
  | 'reserved_fields' // BR2-ED3: hay una reserva activa
  | 'payout_inactive' // BR2-LK5
  | 'invalid_transition'
  | 'limit_reached'; // BR2-LK3

// ---------------------------------------------------------------------------------------------
// Entrada y validacion (BR2-DT1 a DT7)
// ---------------------------------------------------------------------------------------------
const titleSchema = z
  .string()
  .max(400)
  .transform((raw, ctx) => {
    const n = normalizeTitle(raw);
    if (!isValidTitle(n)) {
      ctx.addIssue({ code: 'custom', message: 'invalid' });
      return z.NEVER;
    }
    return n;
  });

const descriptionSchema = z
  .string()
  .max(5000)
  .transform((raw, ctx) => {
    const n = normalizeDescription(raw);
    if (!isValidDescription(n)) {
      ctx.addIssue({ code: 'custom', message: 'invalid' });
      return z.NEVER;
    }
    return n;
  });

const sizeSchema = z.enum(['S', 'M', 'L']);
const modalitySchema = z.enum(['punto', 'recogida']);

/** Entrada de un enlace nuevo. Los importes llegan como texto del formulario ("25,50"). */
export const listingInputSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.optional().transform((d) => d ?? ''),
  price: listingPriceSchema,
  declaredValue: listingPriceSchema.optional(),
  fragile: z
    .boolean()
    .optional()
    .transform((f) => f ?? false),
  size: sizeSchema,
  /** U8: uno o dos origenes. Se admite `modality` (un solo origen) por compatibilidad. */
  origins: z.array(modalitySchema).max(2).optional(),
  modality: modalitySchema.optional(),
});
export type ListingInput = z.infer<typeof listingInputSchema>;

/** Origenes efectivos de una entrada o parche: `origins`, o `[modality]`; vacio si no hay ninguno. */
const originsFrom = (v: {
  readonly origins?: readonly Modality[] | undefined;
  readonly modality?: Modality | undefined;
}): Modality[] | undefined => {
  if (v.origins !== undefined) return normalizeOrigins(v.origins);
  if (v.modality !== undefined) return [v.modality];
  return undefined;
};

/** Datos validados listos para guardar. El valor declarado vale por defecto el precio (BR2-DT4). */
export type ListingDraft = {
  readonly title: string;
  readonly description: string;
  readonly priceCents: number;
  readonly declaredValueCents: number;
  readonly fragile: boolean;
  readonly size: PackageSize;
  readonly modality: Modality;
  readonly origins: readonly Modality[];
};

/** BR8-O1: sin ningun origen la entrada no es valida (la capa de aplicacion lo rechaza). */
export const hasOrigins = (input: ListingInput): boolean => (originsFrom(input) ?? []).length > 0;

export const toDraft = (input: ListingInput): ListingDraft => ({
  title: input.title,
  description: input.description,
  priceCents: input.price.cents,
  declaredValueCents: (input.declaredValue ?? input.price).cents,
  fragile: input.fragile,
  size: input.size,
  modality: modalityOf(originsFrom(input) ?? ['punto']),
  origins: originsFrom(input) ?? ['punto'],
});

/** Parche de edicion: todos los campos son opcionales. */
export const listingPatchSchema = z.object({
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  price: listingPriceSchema.optional(),
  declaredValue: listingPriceSchema.optional(),
  fragile: z.boolean().optional(),
  size: sizeSchema.optional(),
  origins: z.array(modalitySchema).max(2).optional(),
  modality: modalitySchema.optional(),
});
export type ListingPatch = z.infer<typeof listingPatchSchema>;

/** Campos que no se pueden tocar con una reserva activa (BR2-ED3). */
export const touchesReservedFields = (patch: ListingPatch): boolean =>
  patch.price !== undefined ||
  patch.declaredValue !== undefined ||
  patch.size !== undefined ||
  patch.origins !== undefined ||
  patch.modality !== undefined;

const patchedOrigins = (
  listing: Listing,
  patch: ListingPatch,
): { origins: readonly Modality[]; modality: Modality } => {
  const next = originsFrom(patch);
  const origins = next !== undefined && next.length > 0 ? next : listing.origins;
  return { origins, modality: modalityOf(origins) };
};

/**
 * Aplica un parche ya validado (P-U2-14).
 * - vendido: nunca (BR2-ED1).
 * - reserva activa: precio, valor declarado, tamano y modalidad bloqueados (BR2-ED3).
 * - BR2-ED4: si el valor declarado seguia igual al precio, acompana al nuevo precio.
 */
export const applyPatch = (
  listing: Listing,
  patch: ListingPatch,
  hasActiveReservation: boolean,
  now: Instant,
): Result<Listing, ListingError> => {
  if (listing.status === 'vendido') return err('sold');
  if (hasActiveReservation && touchesReservedFields(patch)) return err('reserved_fields');

  const priceCents = patch.price?.cents ?? listing.priceCents;
  let declaredValueCents = listing.declaredValueCents;
  if (patch.declaredValue !== undefined) declaredValueCents = patch.declaredValue.cents;
  else if (patch.price !== undefined && listing.declaredValueCents === listing.priceCents) {
    declaredValueCents = priceCents;
  }

  return ok({
    ...listing,
    title: patch.title ?? listing.title,
    description: patch.description ?? listing.description,
    priceCents,
    declaredValueCents,
    fragile: patch.fragile ?? listing.fragile,
    size: patch.size ?? listing.size,
    ...patchedOrigins(listing, patch),
    updatedAt: now,
  });
};

// ---------------------------------------------------------------------------------------------
// Ciclo de vida (BR2-LK4 a LK6)
// ---------------------------------------------------------------------------------------------
/** activo -> pausado por el artista. Pausar siempre es posible y no cancela reservas (BR2-LK6). */
export const pause = (listing: Listing, now: Instant): Result<Listing, ListingError> => {
  if (listing.status === 'vendido') return err('sold');
  if (listing.status === 'pausado') return err('invalid_transition');
  return ok({ ...listing, status: 'pausado', pausedReason: 'artista', updatedAt: now });
};

/** pausado -> activo; exige cobros activos (BR2-LK5). */
export const resume = (
  listing: Listing,
  payoutActive: boolean,
  now: Instant,
): Result<Listing, ListingError> => {
  if (listing.status === 'vendido') return err('sold');
  if (listing.status !== 'pausado') return err('invalid_transition');
  if (!payoutActive) return err('payout_inactive');
  return ok({ ...listing, status: 'activo', pausedReason: undefined, updatedAt: now });
};

/** activo -> vendido (terminal), solo desde markSold. */
export const markSold = (
  listing: Listing,
  orderId: string | undefined,
  now: Instant,
  /** U3: una obra pausada pero con la reserva de este pedido se puede vender (el pago ya se cobro). */
  allowPaused = false,
): Result<Listing, ListingError> => {
  if (listing.status === 'vendido') return err('sold');
  if (listing.status !== 'activo' && !(allowPaused && listing.status === 'pausado')) {
    return err('invalid_transition');
  }
  return ok({
    ...listing,
    status: 'vendido',
    pausedReason: undefined,
    orderId,
    soldAt: now,
    updatedAt: now,
  });
};

/** BR2-CB10: pausa por restriccion de cobros; solo afecta a los enlaces activos. Idempotente. */
export const pauseForRestriction = (listing: Listing, now: Instant): Listing =>
  listing.status === 'activo'
    ? { ...listing, status: 'pausado', pausedReason: 'cobros_restringidos', updatedAt: now }
    : listing;

/** BR2-LK3: el recuento incluye activos y pausados; los vendidos no cuentan. */
export const countsTowardLimit = (status: ListingStatus): boolean => status !== 'vendido';

export const canCreateMore = (openCount: number, limit = MAX_OPEN_LISTINGS): boolean =>
  openCount < limit;
