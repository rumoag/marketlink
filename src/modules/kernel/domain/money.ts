import { err, ok, type Result } from './result';
import type { MoneyErrorCode } from './app-error';

/** Importe en euros como centimos enteros (BR-M1). */
export type Money = {
  readonly cents: number;
  readonly currency: 'EUR';
};

const NBSP = ' ';

const build = (cents: number): Money => ({ cents, currency: 'EUR' });

const of = (cents: number): Result<Money, MoneyErrorCode> => {
  if (!Number.isSafeInteger(cents)) return err('invalid_amount');
  if (cents < 0) return err('invalid_amount');
  return ok(build(cents));
};

const add = (a: Money, b: Money): Result<Money, MoneyErrorCode> => {
  const sum = a.cents + b.cents;
  return Number.isSafeInteger(sum) ? ok(build(sum)) : err('overflow');
};

const subtract = (a: Money, b: Money): Result<Money, MoneyErrorCode> =>
  a.cents < b.cents ? err('negative_result') : ok(build(a.cents - b.cents));

/** BR-M4: m * bp / 10.000 con redondeo al centimo mas cercano y .5 hacia arriba. */
const percentOf = (m: Money, basisPoints: number): Result<Money, MoneyErrorCode> => {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) return err('invalid_amount');
  const product = BigInt(m.cents) * BigInt(basisPoints);
  const rounded = (product + 5_000n) / 10_000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) return err('overflow');
  return ok(build(Number(rounded)));
};

const compare = (a: Money, b: Money): -1 | 0 | 1 =>
  a.cents < b.cents ? -1 : a.cents > b.cents ? 1 : 0;

const equals = (a: Money, b: Money): boolean => a.cents === b.cents;
const isZero = (m: Money): boolean => m.cents === 0;

/** BR-M5: `1.234,56 €` (miles con `.`, decimal con `,`, espacio duro antes del simbolo). */
const format = (m: Money): string => {
  const whole = Math.floor(m.cents / 100);
  const frac = m.cents % 100;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped},${frac.toString().padStart(2, '0')}${NBSP}€`;
};

// Entero con miles ("1.234.567") o sin ellos, mas decimales opcionales de 1 o 2 digitos.
const PARSE_PATTERN = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:[,.](\d{1,2}))?$/;

/**
 * BR-M6: acepta `,` o `.` como decimal si le siguen 1 o 2 digitos al final; un `.` seguido de
 * exactamente 3 digitos es separador de miles. Rechaza mas de 2 decimales, signos y texto.
 */
const parse = (input: string): Result<Money, MoneyErrorCode> => {
  const cleaned = input.replace(/\s/g, '').replace(/€$/, '');
  const match = PARSE_PATTERN.exec(cleaned);
  if (!match) return err('invalid_amount');
  const wholeDigits = (match[1] ?? '').replace(/\./g, '');
  const fracDigits = (match[2] ?? '').padEnd(2, '0');
  const total = BigInt(wholeDigits) * 100n + BigInt(fracDigits);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return err('overflow');
  return ok(build(Number(total)));
};

export const Money = { of, add, subtract, percentOf, compare, equals, isZero, format, parse };
