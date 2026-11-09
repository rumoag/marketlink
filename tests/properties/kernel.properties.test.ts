import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '@/modules/kernel/domain/money';
import { ListingPrice } from '@/modules/kernel/domain/listing-price';
import { Email, PhoneES, PostalCode } from '@/modules/kernel/domain/formats';
import { err, flatMap, map, ok, type Result } from '@/modules/kernel/domain/result';
import { formatISO, parseISO } from '@/modules/kernel/domain/dates';
import {
  basisPointsArb,
  centsArb,
  instantArb,
  invalidPhoneArb,
  invalidPostalArb,
  listingCentsArb,
  moneyArb,
  smallMoneyArb,
  validEmailArb,
  validPhoneArb,
  validPostalArb,
} from '@tests/support/generators';

const big = (m: { cents: number }) => BigInt(m.cents);

describe('P-U1-01 Money ida y vuelta', () => {
  it('parse(format(m)) = m', () => {
    fc.assert(
      fc.property(moneyArb, (m) => {
        const r = Money.parse(Money.format(m));
        expect(r.ok && r.value.cents).toBe(m.cents);
      }),
    );
  });
});

describe('P-U1-02 Money.add conmutativa e invariante', () => {
  it('add(a,b) = add(b,a) y add(a,b) >= a y >= b; error solo por desbordamiento', () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, (a, b) => {
        const ab = Money.add(a, b);
        const ba = Money.add(b, a);
        expect(ab).toEqual(ba);
        if (ab.ok) {
          expect(ab.value.cents).toBeGreaterThanOrEqual(a.cents);
          expect(ab.value.cents).toBeGreaterThanOrEqual(b.cents);
        } else {
          expect(ab.error).toBe('overflow');
          expect(a.cents + b.cents).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
        }
      }),
    );
  });
});

describe('P-U1-03 Money.add y subtract', () => {
  it('si a >= b, add(subtract(a,b), b) = a; subtract falla sii a < b', () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, (a, b) => {
        const d = Money.subtract(a, b);
        expect(d.ok).toBe(a.cents >= b.cents);
        if (d.ok) {
          const back = Money.add(d.value, b);
          expect(back.ok && back.value.cents).toBe(a.cents);
        } else {
          expect(d.error).toBe('negative_result');
        }
      }),
    );
  });
});

describe('P-U1-04 Money contra un oraculo con BigInt', () => {
  it('add, subtract y percentOf coinciden con la implementacion de referencia', () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, basisPointsArb, (a, b, bp) => {
        const sum = big(a) + big(b);
        const add = Money.add(a, b);
        if (sum <= BigInt(Number.MAX_SAFE_INTEGER)) {
          expect(add.ok && big(add.value)).toBe(sum);
        } else {
          expect(add.ok).toBe(false);
        }
        const product = big(a) * BigInt(bp);
        const expected = product / 10_000n + (product % 10_000n >= 5_000n ? 1n : 0n);
        const pct = Money.percentOf(a, bp);
        expect(pct.ok && big(pct.value)).toBe(expected);
      }),
    );
  });
});

describe('P-U1-05 Money.percentOf', () => {
  it('<= m con bp <= 10.000; 0 da 0; 10.000 da m; monotona en bp', () => {
    fc.assert(
      fc.property(moneyArb, basisPointsArb, basisPointsArb, (m, bp1, bp2) => {
        const p = Money.percentOf(m, bp1);
        expect(p.ok).toBe(true);
        if (p.ok) expect(p.value.cents).toBeLessThanOrEqual(m.cents);
        const zero = Money.percentOf(m, 0);
        expect(zero.ok && zero.value.cents).toBe(0);
        const full = Money.percentOf(m, 10_000);
        expect(full.ok && full.value.cents).toBe(m.cents);
        const [lo, hi] = bp1 <= bp2 ? [bp1, bp2] : [bp2, bp1];
        const a = Money.percentOf(m, lo);
        const b = Money.percentOf(m, hi);
        expect(a.ok && b.ok && a.value.cents <= b.value.cents).toBe(true);
      }),
    );
  });
});

describe('P-U1-06 ListingPrice', () => {
  it('solo se construye si 100 <= cents <= 100.000', () => {
    fc.assert(
      fc.property(centsArb, (c) => {
        const r = ListingPrice.fromCents(c);
        expect(r.ok).toBe(c >= 100 && c <= 100_000);
      }),
    );
    fc.assert(
      fc.property(listingCentsArb, (c) => {
        expect(ListingPrice.fromCents(c).ok).toBe(true);
      }),
    );
  });
});

describe('P-U1-07 leyes de Result', () => {
  const resultArb: fc.Arbitrary<Result<number, string>> = fc.oneof(
    fc.integer().map((n) => ok(n)),
    fc.string().map((s) => err(s)),
  );
  const f = (n: number) => n + 1;
  const g = (n: number) => n * 2;

  it('map(id) = id y map(f∘g) = map(f)∘map(g)', () => {
    fc.assert(
      fc.property(resultArb, (r) => {
        expect(map(r, (x) => x)).toEqual(r);
        expect(map(r, (x) => f(g(x)))).toEqual(map(map(r, g), f));
      }),
    );
  });

  it('Err se propaga sin invocar la funcion', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        let calls = 0;
        const e: Result<number, string> = err(s);
        map(e, (x) => (calls++, x));
        flatMap(e, (x) => (calls++, ok(x)));
        expect(calls).toBe(0);
      }),
    );
  });
});

describe('P-U1-08 normalizacion idempotente', () => {
  it('normalize(normalize(x)) = normalize(x)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (x) => {
        expect(PostalCode.normalize(PostalCode.normalize(x))).toBe(PostalCode.normalize(x));
        expect(PhoneES.normalize(PhoneES.normalize(x))).toBe(PhoneES.normalize(x));
        expect(Email.normalize(Email.normalize(x))).toBe(Email.normalize(x));
      }),
    );
  });
});

describe('P-U1-09 formatos espanoles', () => {
  it('lo valido se acepta y su forma canonica cumple el formato', () => {
    fc.assert(
      fc.property(validPostalArb, (p) => {
        const r = PostalCode.parse(p);
        expect(r.ok && /^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/.test(r.value)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(validPhoneArb, ({ raw, canonical }) => {
        const r = PhoneES.parse(raw);
        expect(r.ok && r.value).toBe(canonical);
      }),
    );
    fc.assert(
      fc.property(validEmailArb, (e) => {
        const r = Email.parse(e);
        expect(r.ok && r.value).toBe(e.trim().toLowerCase());
      }),
    );
  });

  it('lo invalido se rechaza', () => {
    fc.assert(
      fc.property(invalidPostalArb, (p) => {
        expect(PostalCode.parse(p).ok).toBe(false);
      }),
    );
    fc.assert(
      fc.property(invalidPhoneArb, (p) => {
        expect(PhoneES.parse(p).ok).toBe(false);
      }),
    );
  });
});

describe('P-U1-18 fechas ida y vuelta en UTC', () => {
  it('parseISO(formatISO(t)) = t', () => {
    fc.assert(
      fc.property(instantArb, (t) => {
        const r = parseISO(formatISO(t));
        expect(r.ok && r.value).toBe(t);
      }),
    );
  });
});

describe('Money.add sin desbordamiento (apoyo)', () => {
  it('la suma de importes pequenos siempre es Ok', () => {
    fc.assert(
      fc.property(smallMoneyArb, smallMoneyArb, (a, b) => {
        expect(Money.add(a, b).ok).toBe(true);
      }),
    );
  });
});
