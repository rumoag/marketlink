import fc from 'fast-check';
import { instantOf, type Instant } from '@/modules/kernel/domain/clock';
import type { AccountSnapshot } from '@/modules/accounts/domain/payout';
import { PENINSULAR_PREFIXES, PROVINCES_BY_PREFIX } from '@/modules/accounts/domain/provinces';
import { SLUG_ALPHABET } from '@/modules/listings/domain/slug';
import type { Listing } from '@/modules/listings/domain/listing';
import type { Slug } from '@/modules/listings/domain/slug';

/** PBT-07: generadores de dominio de U2 (cuentas, enlaces, fotos, eventos de cuenta). */

export const slugCharArb = fc.constantFrom(...SLUG_ALPHABET.split(''));
export const validSlugArb = fc
  .array(slugCharArb, { minLength: 8, maxLength: 8 })
  .map((c) => c.join(''));

/** Entero en [0, 1) apto para una fuente aleatoria inyectada. */
export const unitFloatArb = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });

/** Usuarios de Instagram validos (1 a 30 caracteres, sin punto inicial/final ni `..`). */
export const validInstagramArb = fc
  .stringMatching(/^[a-z0-9_]([a-z0-9_]|\.[a-z0-9_]){0,14}$/)
  .filter((s) => s.length >= 1 && s.length <= 30);

export const peninsularPrefixArb = fc.constantFrom(...PENINSULAR_PREFIXES);
export const excludedPrefixArb = fc.constantFrom('07', '35', '38', '51', '52');

export const postalWithPrefixArb = (prefix: fc.Arbitrary<string>) =>
  fc
    .tuple(prefix, fc.integer({ min: 0, max: 999 }))
    .map(([p, rest]) => `${p}${String(rest).padStart(3, '0')}`);

export const provinceAliasArb = peninsularPrefixArb.chain((prefix) =>
  fc.constantFrom(...(PROVINCES_BY_PREFIX[prefix] ?? [])).map((name) => ({ prefix, name })),
);

export const snapshotArb = (eventAt: fc.Arbitrary<number> = fc.integer({ min: 0, max: 10_000 })) =>
  fc.record<AccountSnapshot>({
    detailsSubmitted: fc.boolean(),
    transfersActive: fc.boolean(),
    payoutsEnabled: fc.boolean(),
    disabled: fc.boolean(),
    eventAt,
  });

export const enabledSnapshotArb = fc.record<AccountSnapshot>({
  detailsSubmitted: fc.constant(true),
  transfersActive: fc.constant(true),
  payoutsEnabled: fc.constant(true),
  disabled: fc.constant(false),
  eventAt: fc.integer({ min: 0, max: 10_000 }),
});

/** Texto con basura: saltos de linea, tabuladores y caracteres de control. */
const BASIC = 'abc XYZ09.,'.split('');
export const messyTextArb = fc
  .array(
    fc.oneof(
      fc.constantFrom(...BASIC),
      fc.constantFrom(
        String.fromCharCode(10),
        String.fromCharCode(13),
        String.fromCharCode(9),
        String.fromCharCode(1),
        String.fromCharCode(127),
        'á',
        'ñ',
      ),
    ),
    { maxLength: 200 },
  )
  .map((chars) => chars.join(''));

export const listingArb = (overrides: Partial<Listing> = {}): fc.Arbitrary<Listing> =>
  fc
    .record({
      price: fc.integer({ min: 100, max: 100_000 }),
      declared: fc.integer({ min: 100, max: 100_000 }),
      size: fc.constantFrom('S', 'M', 'L' as const),
      modality: fc.constantFrom('punto', 'recogida' as const),
      fragile: fc.boolean(),
      status: fc.constantFrom('activo', 'pausado', 'vendido' as const),
    })
    .map((r): Listing => ({
      id: '00000000-0000-4000-8000-000000000001',
      artistId: '00000000-0000-4000-9000-000000000001',
      slug: 'abcdefgh' as Slug,
      title: 'Titulo de prueba',
      description: '',
      priceCents: r.price,
      declaredValueCents: r.declared,
      fragile: r.fragile,
      size: r.size,
      modality: r.modality,
      status: r.status,
      pausedReason: r.status === 'pausado' ? 'artista' : undefined,
      orderId: undefined,
      createdAt: instantOf(0),
      updatedAt: instantOf(0),
      soldAt: r.status === 'vendido' ? instantOf(1) : undefined,
      ...overrides,
    }));

/** Firmas de imagen reales seguidas de relleno. */
const withPadding = (head: number[], size: number): Uint8Array => {
  const bytes = new Uint8Array(Math.max(size, head.length));
  bytes.set(head);
  return bytes;
};
export const jpegBytesArb = fc
  .integer({ min: 4, max: 400 })
  .map((n) => withPadding([0xff, 0xd8, 0xff, 0xe0], n));
export const pngBytesArb = fc
  .integer({ min: 8, max: 400 })
  .map((n) => withPadding([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], n));
export const webpBytesArb = fc.integer({ min: 12, max: 400 }).map((n) => {
  const b = withPadding([0x52, 0x49, 0x46, 0x46], n);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  return b;
});
export const validImageBytesArb = fc.oneof(jpegBytesArb, pngBytesArb, webpBytesArb);

/** Tiempo base y desplazamientos para propiedades con reloj. */
export const instantBase: Instant = instantOf(1_000_000_000_000);
