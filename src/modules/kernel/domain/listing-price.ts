import { err, ok, type Result } from './result';
import { Money } from './money';
import type { MoneyErrorCode } from './app-error';

/** BR-M8: precio de enlace entre 1,00 € y 1.000,00 € (el valor declarado usa el mismo rango). */
export const MIN_LISTING_CENTS = 100;
export const MAX_LISTING_CENTS = 100_000;

export type ListingPrice = Money & { readonly __brand: 'ListingPrice' };

const fromMoney = (m: Money): Result<ListingPrice, MoneyErrorCode> =>
  m.cents >= MIN_LISTING_CENTS && m.cents <= MAX_LISTING_CENTS
    ? ok(m as ListingPrice)
    : err('out_of_range');

const fromCents = (cents: number): Result<ListingPrice, MoneyErrorCode> => {
  const m = Money.of(cents);
  return m.ok ? fromMoney(m.value) : m;
};

const parse = (input: string): Result<ListingPrice, MoneyErrorCode> => {
  const m = Money.parse(input);
  return m.ok ? fromMoney(m.value) : m;
};

export const ListingPrice = { fromMoney, fromCents, parse };
