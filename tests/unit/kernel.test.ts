import { describe, expect, it } from 'vitest';
import { Money } from '@/modules/kernel/domain/money';
import { ListingPrice } from '@/modules/kernel/domain/listing-price';
import { Email, PhoneES, PostalCode } from '@/modules/kernel/domain/formats';
import { appError, httpStatusFor, ERROR_CODES } from '@/modules/kernel/domain/app-error';
import { formatISO, formatMadrid, parseISO } from '@/modules/kernel/domain/dates';
import { instantOf } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';
import { validate } from '@/modules/kernel/domain/validation';
import { emailSchema, listingPriceSchema, postalCodeSchema } from '@/modules/kernel/domain/schemas';

const NBSP = ' ';

describe('Money (PBT-10, ejemplos)', () => {
  it('format(123456) = "1.234,56 €"', () => {
    expect(Money.format(unwrap(Money.of(123456)))).toBe(`1.234,56${NBSP}€`);
    expect(Money.format(unwrap(Money.of(5)))).toBe(`0,05${NBSP}€`);
    expect(Money.format(unwrap(Money.of(0)))).toBe(`0,00${NBSP}€`);
  });

  it('parse acepta miles, coma y punto decimal', () => {
    expect(unwrap(Money.parse('1.234')).cents).toBe(123_400);
    expect(unwrap(Money.parse('12,5')).cents).toBe(1_250);
    expect(unwrap(Money.parse('12.50')).cents).toBe(1_250);
    expect(unwrap(Money.parse('1.234,56')).cents).toBe(123_456);
    expect(unwrap(Money.parse('25')).cents).toBe(2_500);
    expect(unwrap(Money.parse(`25,00${NBSP}€`)).cents).toBe(2_500);
  });

  it('parse rechaza mas de 2 decimales, signos y texto', () => {
    for (const bad of ['12,345', '-5', '+5', 'abc', '', '1.2.3', '1,2,3', '12,', ',50', '1e3']) {
      expect(Money.parse(bad).ok, bad).toBe(false);
    }
  });

  it('percentOf redondea .5 hacia arriba', () => {
    expect(unwrap(Money.percentOf(unwrap(Money.of(5)), 1_000)).cents).toBe(1); // 0,5 -> 1
    expect(unwrap(Money.percentOf(unwrap(Money.of(4)), 1_000)).cents).toBe(0); // 0,4 -> 0
    expect(unwrap(Money.percentOf(unwrap(Money.of(1_000)), 250)).cents).toBe(25);
  });

  it('subtract y add devuelven los errores definidos', () => {
    const a = unwrap(Money.of(100));
    const b = unwrap(Money.of(200));
    expect(Money.subtract(a, b)).toEqual({ ok: false, error: 'negative_result' });
    const max = unwrap(Money.of(Number.MAX_SAFE_INTEGER));
    expect(Money.add(max, a)).toEqual({ ok: false, error: 'overflow' });
  });

  it('of rechaza negativos y no enteros', () => {
    expect(Money.of(-1).ok).toBe(false);
    expect(Money.of(1.5).ok).toBe(false);
    expect(Money.of(Number.NaN).ok).toBe(false);
    expect(Money.of(Number.MAX_SAFE_INTEGER + 1).ok).toBe(false);
  });

  it('compare, equals e isZero', () => {
    const a = unwrap(Money.of(1));
    const b = unwrap(Money.of(2));
    expect(Money.compare(a, b)).toBe(-1);
    expect(Money.compare(b, a)).toBe(1);
    expect(Money.compare(a, a)).toBe(0);
    expect(Money.equals(a, unwrap(Money.of(1)))).toBe(true);
    expect(Money.isZero(unwrap(Money.of(0)))).toBe(true);
  });
});

describe('ListingPrice (ejemplos)', () => {
  it('1.000,00 € se acepta y 1.000,01 € se rechaza', () => {
    expect(ListingPrice.parse('1000').ok).toBe(true);
    expect(ListingPrice.parse('1.000,00').ok).toBe(true);
    expect(ListingPrice.parse('1000,01').ok).toBe(false);
    expect(ListingPrice.parse('1').ok).toBe(true);
    expect(ListingPrice.parse('0,99').ok).toBe(false);
    expect(ListingPrice.parse('0').ok).toBe(false);
  });
});

describe('Formatos espanoles (ejemplos)', () => {
  it('codigos postales', () => {
    expect(PostalCode.parse('28001').ok).toBe(true);
    expect(PostalCode.parse('01001').ok).toBe(true);
    expect(PostalCode.parse('52001').ok).toBe(true);
    expect(PostalCode.parse('00001').ok).toBe(false);
    expect(PostalCode.parse('53001').ok).toBe(false);
  });

  it('telefonos', () => {
    expect(unwrap(PhoneES.parse('612 345 678'))).toBe('+34612345678');
    expect(unwrap(PhoneES.parse('0034 912-345-678'))).toBe('+34912345678');
    expect(PhoneES.parse('512345678').ok).toBe(false);
  });

  it('emails', () => {
    expect(unwrap(Email.parse('  Ana@Example.COM '))).toBe('ana@example.com');
    expect(Email.parse('sin-arroba').ok).toBe(false);
    expect(Email.parse('a@b').ok).toBe(false);
    expect(Email.parse('a@@b.com').ok).toBe(false);
    expect(Email.parse(`${'a'.repeat(250)}@b.com`).ok).toBe(false);
  });
});

describe('AppError (BR-R2, BR-R3)', () => {
  it('traduce cada codigo al estado HTTP definido', () => {
    expect(httpStatusFor('validation')).toBe(400);
    expect(httpStatusFor('unauthenticated')).toBe(401);
    expect(httpStatusFor('forbidden')).toBe(403);
    expect(httpStatusFor('not_found')).toBe(404);
    expect(httpStatusFor('conflict')).toBe(409);
    expect(httpStatusFor('rate_limited')).toBe(429);
    expect(httpStatusFor('dependency_unavailable')).toBe(503);
    expect(httpStatusFor('internal')).toBe(500);
  });

  it('los mensajes son genericos y los reintentables estan marcados', () => {
    for (const code of ERROR_CODES) {
      const e = appError(code);
      expect(e.message.length).toBeGreaterThan(0);
      expect(e.message).not.toMatch(/stack|select |postgres|supabase|\//i);
    }
    expect(appError('dependency_unavailable').retryable).toBe(true);
    expect(appError('validation').retryable).toBe(false);
  });
});

describe('Fechas (ejemplos)', () => {
  it('formatISO/parseISO en UTC', () => {
    const t = instantOf(Date.UTC(2026, 10, 4, 12, 30, 0));
    expect(formatISO(t)).toBe('2026-11-04T12:30:00.000Z');
    expect(unwrap(parseISO('2026-11-04T12:30:00.000Z'))).toBe(t);
    expect(parseISO('no es fecha').ok).toBe(false);
  });

  it('presenta en Europe/Madrid (horario de invierno y de verano)', () => {
    const winter = instantOf(Date.UTC(2026, 0, 15, 12, 0, 0)); // UTC+1
    const summer = instantOf(Date.UTC(2026, 6, 15, 12, 0, 0)); // UTC+2
    expect(formatMadrid(winter)).toContain('13:00');
    expect(formatMadrid(summer)).toContain('14:00');
  });
});

describe('Validacion con Zod (BR-R5)', () => {
  it('devuelve campos y motivo generico sin reflejar el valor', () => {
    const secret = 'valor-secreto-123';
    const r = validate(emailSchema, secret);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('validation');
      expect(JSON.stringify(r.error)).not.toContain(secret);
    }
  });

  it('transforma a formas canonicas', () => {
    expect(unwrap(validate(postalCodeSchema, ' 28 001 '))).toBe('28001');
    expect(unwrap(validate(listingPriceSchema, '25,50')).cents).toBe(2_550);
    expect(validate(listingPriceSchema, '5000').ok).toBe(false);
  });
});
