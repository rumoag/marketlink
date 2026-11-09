import { describe, expect, it } from 'vitest';
import { instantOf, MS } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { addressSchema, profileSchema } from '@/modules/accounts/domain/artist';
import { parseInstagram } from '@/modules/accounts/domain/instagram-handle';
import { applyAccountEvent, nextPayoutStatus } from '@/modules/accounts/domain/payout';
import { parsePeninsularPostalCode } from '@/modules/accounts/domain/postal';
import { provinceMatchesPostalCode } from '@/modules/accounts/domain/provinces';
import { isSessionValid } from '@/modules/accounts/domain/session';
import { buildDmText } from '@/modules/listings/domain/dm';
import { listingInputSchema, toDraft } from '@/modules/listings/domain/listing';
import {
  detectImageType,
  MAX_UPLOAD_BYTES,
  validateUpload,
} from '@/modules/listings/domain/photo-rules';
import { generateSlug, parseSlug } from '@/modules/listings/domain/slug';
import { tryReserve, type Reservation } from '@/modules/listings/domain/reservation';
import { SeqRandom } from '@tests/support/stubs';

describe('Instagram (PBT-10, ejemplos)', () => {
  it('normaliza y valida', () => {
    expect(unwrap(parseInstagram('@Ana.Art'))).toBe('ana.art');
    expect(unwrap(parseInstagram('  ana_art  '))).toBe('ana_art');
    for (const bad of ['a..b', '.a', 'a.', 'a'.repeat(31), 'a b', '', '@', 'a-b', 'ñandú']) {
      expect(parseInstagram(bad).ok, bad).toBe(false);
    }
    expect(parseInstagram('a'.repeat(30)).ok).toBe(true);
  });
});

describe('Codigos postales y provincias (ejemplos)', () => {
  it('peninsula si, islas y ciudades autonomas no', () => {
    expect(parsePeninsularPostalCode('28001').ok).toBe(true);
    expect(parsePeninsularPostalCode('08001').ok).toBe(true);
    for (const cp of ['07001', '35001', '38001', '51001', '52001']) {
      const r = parsePeninsularPostalCode(cp);
      expect(!r.ok && r.error, cp).toBe('outside_peninsula');
    }
    expect(parsePeninsularPostalCode('00001').ok).toBe(false);
    expect(parsePeninsularPostalCode('2800').ok).toBe(false);
  });

  it('la provincia debe corresponder al codigo postal', () => {
    expect(provinceMatchesPostalCode('28001', 'Madrid')).toBe(true);
    expect(provinceMatchesPostalCode('28001', ' madrid ')).toBe(true);
    expect(provinceMatchesPostalCode('28001', 'Barcelona')).toBe(false);
    expect(provinceMatchesPostalCode('15001', 'A Coruña')).toBe(true);
    expect(provinceMatchesPostalCode('15001', 'La Coruna')).toBe(true);
    expect(provinceMatchesPostalCode('48001', 'Vizcaya')).toBe(true);
    expect(provinceMatchesPostalCode('48001', 'Bizkaia')).toBe(true);
  });
});

describe('Perfil y direccion (esquemas)', () => {
  it('el perfil canoniza los campos', () => {
    const p = unwrap({
      ok: true as const,
      value: profileSchema.parse({
        artisticName: '  Ana   Art ',
        instagram: '@Ana',
        phone: '612 34 56 78',
      }),
    });
    expect(p).toEqual({ artisticName: 'Ana Art', instagram: 'ana', phone: '+34612345678' });
  });

  it('el perfil rechaza nombre corto o telefono invalido', () => {
    expect(
      profileSchema.safeParse({ artisticName: 'A', instagram: 'ana', phone: '612345678' }).success,
    ).toBe(false);
    expect(
      profileSchema.safeParse({ artisticName: 'Ana', instagram: 'ana', phone: '512345678' })
        .success,
    ).toBe(false);
  });

  it('la direccion exige coherencia entre codigo postal y provincia y zona peninsular', () => {
    const base = { street: 'Calle Mayor', number: '1', city: 'Madrid', phone: '612345678' };
    expect(
      addressSchema.safeParse({ ...base, postalCode: '28001', province: 'Madrid' }).success,
    ).toBe(true);
    expect(
      addressSchema.safeParse({ ...base, postalCode: '28001', province: 'Barcelona' }).success,
    ).toBe(false);
    expect(
      addressSchema.safeParse({ ...base, postalCode: '35001', province: 'Las Palmas' }).success,
    ).toBe(false);
    expect(
      addressSchema.safeParse({ ...base, postalCode: '28001', province: 'Madrid', number: '' })
        .success,
    ).toBe(false);
  });
});

describe('Estado de cobros (ejemplos)', () => {
  const snap = (over: Partial<Parameters<typeof applyAccountEvent>[1]> = {}) => ({
    detailsSubmitted: true,
    transfersActive: true,
    payoutsEnabled: true,
    disabled: false,
    eventAt: 100,
    ...over,
  });

  it('transferencias y payouts activos dan activo; solo charges_enabled no existe en el modelo', () => {
    expect(nextPayoutStatus('onboarding_pendiente', snap())).toBe('activo');
    expect(nextPayoutStatus('onboarding_pendiente', snap({ transfersActive: false }))).toBe(
      'onboarding_pendiente',
    );
    expect(nextPayoutStatus('sin_iniciar', snap({ payoutsEnabled: false }))).toBe(
      'onboarding_pendiente',
    );
  });

  it('activo con disabled pasa a restringido y lo avisa una sola vez', () => {
    const active = applyAccountEvent({ status: 'sin_iniciar' }, snap()).state;
    expect(active.status).toBe('activo');
    const restricted = applyAccountEvent(active, snap({ disabled: true, eventAt: 200 }));
    expect(restricted.state.status).toBe('restringido');
    expect(restricted.becameRestricted).toBe(true);
    expect(restricted.state.requirementsHint).toBe('deshabilitada');
    const again = applyAccountEvent(restricted.state, snap({ disabled: true, eventAt: 300 }));
    expect(again.becameRestricted).toBe(false);
  });

  it('recuperar la cuenta devuelve activo', () => {
    const state = applyAccountEvent(
      applyAccountEvent({ status: 'sin_iniciar' }, snap()).state,
      snap({ disabled: true, eventAt: 200 }),
    ).state;
    expect(applyAccountEvent(state, snap({ eventAt: 300 })).state.status).toBe('activo');
  });
});

describe('Sesion (ejemplos)', () => {
  const t = (ms: number) => instantOf(ms);
  it('valida a los 6 dias 23 h de inactividad e invalida a los 7 dias', () => {
    const start = t(0);
    const now = t(20 * MS.day);
    expect(
      isSessionValid({ createdAt: start, lastActivityAt: t(now - (7 * MS.day - MS.hour)) }, now),
    ).toBe(true);
    expect(isSessionValid({ createdAt: start, lastActivityAt: t(now - 7 * MS.day) }, now)).toBe(
      false,
    );
  });
  it('invalida a los 30 dias aunque haya actividad reciente', () => {
    const now = t(30 * MS.day);
    expect(isSessionValid({ createdAt: t(0), lastActivityAt: t(now - MS.minute) }, now)).toBe(
      false,
    );
    expect(isSessionValid({ createdAt: t(1), lastActivityAt: t(now - MS.minute) }, now)).toBe(true);
  });
});

describe('Enlace: precio, texto y DM (ejemplos)', () => {
  const base = { title: 'Oleo', size: 'M', modality: 'punto' } as const;

  it('limites de titulo y descripcion', () => {
    expect(listingInputSchema.safeParse({ ...base, title: 'ab', price: '10' }).success).toBe(false);
    expect(listingInputSchema.safeParse({ ...base, title: 'abc', price: '10' }).success).toBe(true);
    expect(
      listingInputSchema.safeParse({ ...base, title: 'a'.repeat(80), price: '10' }).success,
    ).toBe(true);
    expect(
      listingInputSchema.safeParse({ ...base, title: 'a'.repeat(81), price: '10' }).success,
    ).toBe(false);
    expect(
      listingInputSchema.safeParse({ ...base, price: '10', description: 'x'.repeat(1001) }).success,
    ).toBe(false);
    expect(
      listingInputSchema.safeParse({ ...base, price: '10', description: 'x'.repeat(1000) }).success,
    ).toBe(true);
  });

  it('precio de 1 a 1.000 euros', () => {
    for (const price of ['0,99', '1000,01', '0', '-5', 'abc']) {
      expect(listingInputSchema.safeParse({ ...base, price }).success, price).toBe(false);
    }
    for (const price of ['1', '1000', '25,50']) {
      expect(listingInputSchema.safeParse({ ...base, price }).success, price).toBe(true);
    }
  });

  it('el valor declarado por defecto es el precio y fragile es falso', () => {
    const draft = toDraft(listingInputSchema.parse({ ...base, price: '25,50' }));
    expect(draft).toMatchObject({ priceCents: 2550, declaredValueCents: 2550, fragile: false });
  });

  it('texto de DM de "Oleo sobre lienzo" a 250 euros con slug k7m2x9qa', () => {
    const nbsp = String.fromCharCode(160);
    expect(
      buildDmText(
        { title: 'Óleo sobre lienzo', priceCents: 25000, slug: 'k7m2x9qa' },
        'https://app.test',
      ),
    ).toBe(
      `Óleo sobre lienzo — 250,00${nbsp}€\nCómpramela aquí con envío incluido:\nhttps://app.test/k7m2x9qa`,
    );
  });
});

describe('Slug (ejemplos)', () => {
  it('genera 8 caracteres y se analiza con mayusculas y espacios', () => {
    const slug = generateSlug(new SeqRandom([0, 0.5, 0.99]));
    expect(slug).toHaveLength(8);
    expect(unwrap(parseSlug(`  ${slug.toUpperCase()} `))).toBe(slug);
    expect(parseSlug('k7m2x9q').ok).toBe(false);
    expect(parseSlug('k7m2x9q0').ok).toBe(false); // 0 no pertenece al alfabeto
    expect(parseSlug('k7m2x9ql').ok).toBe(false); // l tampoco
  });
});

describe('Fotos (ejemplos)', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

  it('acepta firmas reales y rechaza un PDF renombrado', () => {
    expect(detectImageType(jpeg)).toBe('jpeg');
    const pdf = new TextEncoder().encode('%PDF-1.7 contenido');
    const r = validateUpload(pdf);
    expect(!r.ok && r.error).toBe('unsupported_type');
  });

  it('rechaza vacio y mas de 4 MB', () => {
    expect(validateUpload(new Uint8Array(0)).ok).toBe(false);
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    const r = validateUpload(big);
    expect(!r.ok && r.error).toBe('too_large');
    const exact = new Uint8Array(MAX_UPLOAD_BYTES);
    exact.set([0xff, 0xd8, 0xff]);
    expect(validateUpload(exact).ok).toBe(true);
  });
});

describe('Reserva (ejemplos)', () => {
  const listing = { id: 'l1', artistId: 'a1', status: 'activo' } as const;
  const active: Reservation = {
    id: 'r1',
    listingId: 'l1',
    artistId: 'a1',
    status: 'activa',
    expiresAt: instantOf(1000),
  };

  it('no se reserva con una reserva vigente, pero si cuando ha vencido', () => {
    expect(tryReserve(listing, [active], 500, instantOf(500), 'r2').ok).toBe(false);
    expect(tryReserve(listing, [active], 500, instantOf(1000), 'r2').ok).toBe(true);
  });

  it('no se reserva un enlace pausado o vendido', () => {
    for (const status of ['pausado', 'vendido'] as const) {
      const r = tryReserve({ ...listing, status }, [], 500, instantOf(0), 'r2');
      expect(!r.ok && r.error).toBe('not_available');
    }
  });
});
