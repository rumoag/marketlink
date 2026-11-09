import fc from 'fast-check';
import { Money } from '@/modules/kernel/domain/money';
import { instantOf, type Clock, type Instant } from '@/modules/kernel/domain/clock';
import { unwrap } from '@/modules/kernel/domain/result';

/** PBT-07: generadores reutilizables de dominio. */

export const centsArb = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 10_000_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(0, 1, 99, 100, 100_000, 100_001, Number.MAX_SAFE_INTEGER),
  },
);

export const moneyArb = centsArb.map((c) => unwrap(Money.of(c)));

/** Importes pequenos: la suma de dos nunca desborda. */
export const smallMoneyArb = fc
  .integer({ min: 0, max: 1_000_000_000 })
  .map((c) => unwrap(Money.of(c)));

export const basisPointsArb = fc.integer({ min: 0, max: 10_000 });

export const listingCentsArb = fc.integer({ min: 100, max: 100_000 });

/** Codigos postales validos (provincia 01 a 52). */
export const validPostalArb = fc
  .tuple(fc.integer({ min: 1, max: 52 }), fc.integer({ min: 0, max: 999 }))
  .map(([p, rest]) => `${String(p).padStart(2, '0')}${String(rest).padStart(3, '0')}`);

export const invalidPostalArb = fc.oneof(
  fc
    .string({ maxLength: 8 })
    .filter((s) => !/^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/.test(s.replace(/\s+/g, ''))),
  fc.constantFrom('00000', '53000', '99999', '1234', '123456', '08O01'),
);

/** Telefonos espanoles validos con separadores y prefijos variados. */
export const validPhoneArb = fc
  .tuple(
    fc.constantFrom('6', '7', '8', '9'),
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 8 }),
    fc.constantFrom('', '+34', '0034', '+34 ', '0034 '),
    fc.constantFrom('', ' ', '-'),
  )
  .map(([first, rest, prefix, sep]) => {
    const digits = [first, ...rest.map(String)];
    const formatted = [
      digits.slice(0, 3).join(''),
      digits.slice(3, 6).join(''),
      digits.slice(6).join(''),
    ].join(sep);
    return { raw: `${prefix}${formatted}`, canonical: `+34${digits.join('')}` };
  });

export const invalidPhoneArb = fc.oneof(
  fc.constantFrom('512345678', '12345', '+34 112345678', '+44 612345678', 'abcdefghi', ''),
  fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 7 }).map((d) => d.join('')),
);

export const validEmailArb = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,15}$/),
    fc.stringMatching(/^[a-z0-9]{1,10}$/),
    fc.constantFrom('com', 'es', 'org', 'net'),
    fc.constantFrom('', ' ', '  '),
  )
  .map(([local, domain, tld, pad]) => `${pad}${local}@${domain}.${tld}${pad}`);

/** Instantes UTC entre 1970 y 2200. */
export const instantArb = fc
  .integer({ min: 0, max: 7_258_118_400_000 })
  .map((ms): Instant => instantOf(ms));

/** Reloj controlable para propiedades con estado (PBT-07). */
export class FakeClock implements Clock {
  private current: number;
  constructor(start = 0) {
    this.current = start;
  }
  now(): Instant {
    return instantOf(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}
