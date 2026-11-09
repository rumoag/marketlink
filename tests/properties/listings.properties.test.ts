import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '@/modules/kernel/domain/money';
import { instantOf, MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { buildDmText } from '@/modules/listings/domain/dm';
import {
  applyPatch,
  canCreateMore,
  listingInputSchema,
  listingPatchSchema,
  markSold,
  pause,
  pauseForRestriction,
  resume,
  toDraft,
  touchesReservedFields,
  type Listing,
} from '@/modules/listings/domain/listing';
import {
  canRemovePhoto,
  compactPositions,
  detectImageType,
  FULL_MAX_SIDE,
  isValidPhotoCount,
  THUMB_MAX_SIDE,
  targetDimensions,
  validateUpload,
} from '@/modules/listings/domain/photo-rules';
import {
  generateSlug,
  normalizeSlug,
  parseSlug,
  SLUG_ALPHABET,
} from '@/modules/listings/domain/slug';
import { isDescriptionOk, isTitleOk, hasControl } from '@tests/support/text-helpers';
import { normalizeDescription, normalizeTitle } from '@/modules/listings/domain/text';
import { buildHarness } from '@tests/support/harness';
import {
  listingArb,
  messyTextArb,
  unitFloatArb,
  validImageBytesArb,
  validSlugArb,
} from '@tests/support/u2-generators';
import { SeqRandom } from '@tests/support/stubs';

// ---------------------------------------------------------------------------------------------
describe('P-U2-01 a P-U2-03 Slug', () => {
  const alphabetRe = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;

  it('P-U2-01: todo slug generado tiene 8 caracteres del alfabeto, sin ambiguos', () => {
    fc.assert(
      fc.property(fc.array(unitFloatArb, { minLength: 1, maxLength: 16 }), (values) => {
        const slug = generateSlug(new SeqRandom(values));
        expect(slug).toMatch(alphabetRe);
        expect(slug).not.toMatch(/[ilo01]/);
      }),
    );
  });

  it('P-U2-02: normalize es idempotente y un slug generado es un punto fijo', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (x) => {
        expect(normalizeSlug(normalizeSlug(x))).toBe(normalizeSlug(x));
      }),
    );
    fc.assert(
      fc.property(validSlugArb, (s) => {
        expect(normalizeSlug(s)).toBe(s);
      }),
    );
  });

  it('P-U2-03: parse acepta exactamente las cadenas de 8 caracteres del alfabeto y nunca lanza', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 12 }), validSlugArb), (x) => {
        const n = normalizeSlug(x);
        const expected = n.length === 8 && [...n].every((c) => SLUG_ALPHABET.includes(c));
        expect(parseSlug(x).ok).toBe(expected);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-07 y P-U2-08 textos del enlace', () => {
  it('P-U2-07: la normalizacion es idempotente y no deja caracteres de control', () => {
    fc.assert(
      fc.property(messyTextArb, (x) => {
        const title = normalizeTitle(x);
        expect(normalizeTitle(title)).toBe(title);
        expect(hasControl(title, false)).toBe(false);
        const desc = normalizeDescription(x);
        expect(normalizeDescription(desc)).toBe(desc);
        expect(hasControl(desc, true)).toBe(false); // solo se permite el salto de linea
      }),
    );
  });

  it('P-U2-08: el titulo se acepta sii mide de 3 a 80 y la descripcion sii mide hasta 1.000', () => {
    fc.assert(
      fc.property(messyTextArb, messyTextArb, (title, description) => {
        const parsed = listingInputSchema.safeParse({
          title,
          description,
          price: '25',
          size: 'M',
          modality: 'punto',
        });
        const expected =
          isTitleOk(normalizeTitle(title)) && isDescriptionOk(normalizeDescription(description));
        expect(parsed.success).toBe(expected);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-09 valor declarado', () => {
  const base = { title: 'Obra bonita', size: 'S', modality: 'recogida' } as const;

  it('sin valor explicito vale el precio; con valor valido se respeta', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined }),
        (price, declared) => {
          const parsed = listingInputSchema.parse({
            ...base,
            price: String(price),
            ...(declared !== undefined ? { declaredValue: String(declared) } : {}),
          });
          const draft = toDraft(parsed);
          expect(draft.priceCents).toBe(price * 100);
          expect(draft.declaredValueCents).toBe((declared ?? price) * 100);
        },
      ),
    );
  });

  it('un valor declarado fuera de rango se rechaza', () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer({ min: 1001, max: 5000 }), fc.constant(0)), (declared) => {
        const r = listingInputSchema.safeParse({
          ...base,
          price: '10',
          declaredValue: String(declared),
        });
        expect(r.success).toBe(false);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-13 ciclo de vida del enlace (modelo de referencia)', () => {
  type Op =
    | { kind: 'pause' }
    | { kind: 'resume'; payoutActive: boolean }
    | { kind: 'sold' }
    | { kind: 'restrict' }
    | { kind: 'patch' };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.constant<Op>({ kind: 'pause' }),
    fc.boolean().map((payoutActive): Op => ({ kind: 'resume', payoutActive })),
    fc.constant<Op>({ kind: 'sold' }),
    fc.constant<Op>({ kind: 'restrict' }),
    fc.constant<Op>({ kind: 'patch' }),
  );

  it('vendido es terminal; reanudar sin cobros activos falla; el estado coincide con el modelo', () => {
    fc.assert(
      fc.property(
        listingArb({ status: 'activo', pausedReason: undefined, soldAt: undefined }),
        fc.array(opArb, { maxLength: 30 }),
        (initial, ops) => {
          let listing: Listing = initial;
          let model: 'activo' | 'pausado' | 'vendido' = 'activo';
          const now = instantOf(5);

          for (const op of ops) {
            if (op.kind === 'pause') {
              const r = pause(listing, now);
              expect(r.ok).toBe(model === 'activo');
              if (r.ok) {
                listing = r.value;
                model = 'pausado';
              }
            } else if (op.kind === 'resume') {
              const r = resume(listing, op.payoutActive, now);
              expect(r.ok).toBe(model === 'pausado' && op.payoutActive);
              if (r.ok) {
                listing = r.value;
                model = 'activo';
              }
            } else if (op.kind === 'sold') {
              const r = markSold(listing, undefined, now);
              expect(r.ok).toBe(model === 'activo');
              if (r.ok) {
                listing = r.value;
                model = 'vendido';
              }
            } else if (op.kind === 'restrict') {
              listing = pauseForRestriction(listing, now);
              if (model === 'activo') model = 'pausado';
            } else {
              const r = applyPatch(listing, {}, false, now);
              expect(r.ok).toBe(model !== 'vendido');
            }
            expect(listing.status).toBe(model);
            if (model === 'vendido') expect(listing.soldAt).toBeDefined();
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-14 regla de edicion', () => {
  const patchArb = fc
    .record({
      title: fc.option(fc.constant('Nuevo titulo'), { nil: undefined }),
      description: fc.option(fc.constant('Nueva descripcion'), { nil: undefined }),
      price: fc.option(fc.integer({ min: 1, max: 1000 }).map(String), { nil: undefined }),
      declaredValue: fc.option(fc.integer({ min: 1, max: 1000 }).map(String), { nil: undefined }),
      fragile: fc.option(fc.boolean(), { nil: undefined }),
      size: fc.option(fc.constantFrom('S', 'M', 'L'), { nil: undefined }),
      modality: fc.option(fc.constantFrom('punto', 'recogida'), { nil: undefined }),
    })
    .map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));

  it('con reserva activa no se tocan precio, valor declarado, tamano ni modalidad; vendido nunca; si no, se aplica', () => {
    fc.assert(
      fc.property(listingArb(), patchArb, fc.boolean(), (listing, rawPatch, reserved) => {
        const patch = listingPatchSchema.parse(rawPatch);
        const result = applyPatch(listing, patch, reserved, instantOf(9));
        if (listing.status === 'vendido') {
          expect(!result.ok && result.error).toBe('sold');
        } else if (reserved && touchesReservedFields(patch)) {
          expect(!result.ok && result.error).toBe('reserved_fields');
        } else {
          expect(result.ok).toBe(true);
          const next = unwrap(result);
          expect(next.title).toBe(patch.title ?? listing.title);
          expect(next.fragile).toBe(patch.fragile ?? listing.fragile);
          expect(next.size).toBe(patch.size ?? listing.size);
          expect(next.priceCents).toBe(patch.price?.cents ?? listing.priceCents);
          // BR2-ED4
          if (patch.declaredValue) expect(next.declaredValueCents).toBe(patch.declaredValue.cents);
          else if (patch.price && listing.declaredValueCents === listing.priceCents) {
            expect(next.declaredValueCents).toBe(next.priceCents);
          } else expect(next.declaredValueCents).toBe(listing.declaredValueCents);
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-15 limite de enlaces', () => {
  it('canCreateMore es verdadero sii hay menos del limite', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), (n) => {
        expect(canCreateMore(n)).toBe(n < 20);
      }),
    );
  });

  it('con el limite alcanzado crear falla; los vendidos no cuentan (servicio)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('create', 'sell', 'pause'), { minLength: 1, maxLength: 14 }),
        async (ops) => {
          const h = buildHarness({ maxOpenListings: 3 });
          const artistId = await h.readyArtist();
          const open = () =>
            [...h.db.state.listings.values()].filter((l) => l.status !== 'vendido').length;

          for (const op of ops) {
            if (op === 'create') {
              const before = open();
              const r = await h.createListing(artistId);
              expect(r.ok).toBe(before < 3);
            } else {
              const target = [...h.db.state.listings.values()].find((l) => l.status === 'activo');
              if (!target) continue;
              if (op === 'sell') await h.reservations.markSold(target.id, undefined);
              else await h.listings.pause(artistId, target.id);
            }
            expect(open()).toBeLessThanOrEqual(3);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-16 texto de DM', () => {
  it('tiene tres lineas: titulo y precio, frase fija y URL', () => {
    fc.assert(
      fc.property(
        messyTextArb.map(normalizeTitle).filter(isTitleOk),
        fc.integer({ min: 100, max: 100_000 }),
        validSlugArb,
        fc.constantFrom('https://app.test', 'https://app.test/', 'https://app.test///'),
        (title, cents, slug, base) => {
          const text = buildDmText({ title, priceCents: cents, slug }, base);
          const lines = text.split('\n');
          expect(lines).toHaveLength(3);
          const price = Money.format(unwrap(Money.of(cents)));
          expect(lines[0]).toBe(`${title} — ${price}`);
          expect(lines[1]).toBe('Cómpramela aquí con envío incluido:');
          expect(lines[2]).toBe(`https://app.test/${slug}`);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-17 a P-U2-19 fotos', () => {
  const kindOf = (b: Uint8Array): string | null => {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((x, i) => b[i] === x)) return 'png';
    const riff = [0x52, 0x49, 0x46, 0x46].every((x, i) => b[i] === x);
    const webp = [0x57, 0x45, 0x42, 0x50].every((x, i) => b[8 + i] === x);
    return riff && webp ? 'webp' : null;
  };

  it('P-U2-17: solo se acepta con una firma real, con independencia de lo declarado', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expect(detectImageType(bytes)).toBe(kindOf(bytes));
      }),
    );
    fc.assert(
      fc.property(validImageBytesArb, (bytes) => {
        expect(detectImageType(bytes)).not.toBeNull();
        expect(validateUpload(bytes).ok).toBe(true);
      }),
    );
  });

  it('P-U2-17: contenido aleatorio nunca se acepta como imagen', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 200 }).filter((b) => kindOf(b) === null),
        (bytes) => {
          const r = validateUpload(bytes);
          expect(!r.ok && r.error).toBe('unsupported_type');
        },
      ),
    );
  });

  it('P-U2-18: el recuento valido es de 1 a 3, las posiciones quedan 1..n y no se quita la ultima', () => {
    fc.assert(
      fc.property(fc.integer({ min: -2, max: 8 }), (n) => {
        expect(isValidPhotoCount(n)).toBe(n >= 1 && n <= 3);
        expect(canRemovePhoto(n)).toBe(n > 1);
      }),
    );
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 20 }), { minLength: 0, maxLength: 3 }),
        (positions) => {
          const compact = compactPositions(positions.map((position) => ({ position })));
          expect(compact.map((p) => p.position)).toEqual(compact.map((_, i) => i + 1));
        },
      ),
    );
  });

  it('P-U2-18: con el servicio, quitar fotos nunca deja menos de una y las posiciones se compactan', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('add', 'remove-first', 'remove-last'), { maxLength: 10 }),
        async (ops) => {
          const h = buildHarness();
          const artistId = await h.readyArtist();
          const listing = unwrap(await h.createListing(artistId));
          const photos = () =>
            [...h.db.state.photos.values()]
              .filter((p) => p.listingId === listing.id)
              .sort((a, b) => a.position - b.position);

          for (const op of ops) {
            const current = photos();
            if (op === 'add') {
              const [uploadId] = await h.uploadPhotos(artistId, 1);
              await h.listings.addPhoto(artistId, listing.id, uploadId as string);
            } else {
              const target = op === 'remove-first' ? current[0] : current[current.length - 1];
              if (target) await h.listings.removePhoto(artistId, listing.id, target.id);
            }
            const after = photos();
            expect(after.length).toBeGreaterThanOrEqual(1);
            expect(after.length).toBeLessThanOrEqual(3);
            expect(after.map((p) => p.position)).toEqual(after.map((_, i) => i + 1));
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('P-U2-19: el lado largo es min(original, maximo), se conserva la proporcion y nunca se amplia', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12_000 }),
        fc.integer({ min: 1, max: 12_000 }),
        fc.constantFrom(FULL_MAX_SIDE, THUMB_MAX_SIDE),
        (w, h, max) => {
          const out = targetDimensions(w, h, max);
          expect(Math.max(out.width, out.height)).toBe(Math.min(Math.max(w, h), max));
          expect(out.width).toBeLessThanOrEqual(w);
          expect(out.height).toBeLessThanOrEqual(h);
          // proporcion: el lado corto escalado coincide con el original con error <= 1 px
          const scale = Math.max(out.width, out.height) / Math.max(w, h);
          expect(Math.abs(out.width - w * scale)).toBeLessThanOrEqual(1);
          expect(Math.abs(out.height - h * scale)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-21 reserva (modelo de referencia)', () => {
  type Op =
    | { kind: 'reserve'; ttl: number }
    | { kind: 'release' }
    | { kind: 'advance'; ms: number }
    | { kind: 'sold' }
    | { kind: 'pause' };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.constantFrom(60_000, 600_000).map((ttl): Op => ({ kind: 'reserve', ttl })),
    fc.constant<Op>({ kind: 'release' }),
    fc
      .constantFrom(30_000, 5 * MS.minute, 20 * MS.minute)
      .map((ms): Op => ({ kind: 'advance', ms })),
    fc.constant<Op>({ kind: 'sold' }),
    fc.constant<Op>({ kind: 'pause' }),
  );

  it('nunca hay dos reservas activas; reservar un enlace no activo falla; una vencida no bloquea', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 25 }), async (ops) => {
        const h = buildHarness();
        const artistId = await h.readyArtist();
        const listing = unwrap(await h.createListing(artistId));
        let model: { status: string; activeUntil: number | undefined } = {
          status: 'activo',
          activeUntil: undefined,
        };
        let lastId: string | undefined;

        for (const op of ops) {
          const now = h.clock.now();
          const live = model.activeUntil !== undefined && model.activeUntil > now;
          if (op.kind === 'reserve') {
            const r = await h.reservations.reserve(listing.id, op.ttl);
            const expectedOk = model.status === 'activo' && !live;
            expect(r.ok).toBe(expectedOk);
            if (r.ok) {
              model.activeUntil = now + op.ttl;
              lastId = r.value.id;
            }
          } else if (op.kind === 'release') {
            if (lastId) await h.reservations.release(lastId);
            if (live) model.activeUntil = undefined;
          } else if (op.kind === 'advance') {
            h.clock.advance(op.ms);
          } else if (op.kind === 'pause') {
            await h.listings.pause(artistId, listing.id);
            if (model.status === 'activo') model = { ...model, status: 'pausado' };
          } else {
            const r = await h.reservations.markSold(listing.id, undefined);
            expect(r.ok).toBe(model.status === 'activo');
            if (r.ok) model = { status: 'vendido', activeUntil: undefined };
          }
          const activeNow = [...h.db.state.reservations.values()].filter(
            (r) => r.status === 'activa' && r.expiresAt > h.clock.now(),
          );
          expect(activeNow.length).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 40 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-22 autorizacion por objeto', () => {
  it('otro artista no puede leer ni modificar un enlace ajeno y no cambia nada', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('update', 'pause', 'resume', 'get', 'dm', 'addPhoto', 'removePhoto'),
        async (op) => {
          const h = buildHarness();
          const owner = await h.readyArtist('ana@example.com');
          const intruder = await h.readyArtist('berta@example.com');
          const listing = unwrap(await h.createListing(owner));
          const photoId = [...h.db.state.photos.values()][0]?.id as string;
          const [uploadId] = await h.uploadPhotos(intruder, 1);
          const before = structuredClone({
            listings: [...h.db.state.listings.values()],
            photos: [...h.db.state.photos.values()],
          });

          const results = {
            update: () => h.listings.updateListing(intruder, listing.id, { title: 'Pirateado' }),
            pause: () => h.listings.pause(intruder, listing.id),
            resume: () => h.listings.resume(intruder, listing.id),
            get: () => h.listings.getMine(intruder, listing.id),
            dm: () => h.listings.getDmText(intruder, listing.id),
            addPhoto: () => h.listings.addPhoto(intruder, listing.id, uploadId as string),
            removePhoto: () => h.listings.removePhoto(intruder, listing.id, photoId),
          };
          const r = await results[op]();
          expect(r.ok).toBe(false);
          expect(!r.ok && r.error.code).toBe('not_found');
          expect({
            listings: [...h.db.state.listings.values()],
            photos: [...h.db.state.photos.values()],
          }).toEqual(before);

          // La lista del intruso no incluye el enlace ajeno.
          const mine = unwrap(await h.listings.listMine(intruder));
          expect(mine.some((v) => v.listing.id === listing.id)).toBe(false);
        },
      ),
      { numRuns: 20 },
    );
  });
});
