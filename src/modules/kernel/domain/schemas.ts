import { z } from 'zod';
import { Email, PhoneES, PostalCode } from './formats';
import { ListingPrice } from './listing-price';
import type { Result } from './result';

/** Esquemas compartidos entre cliente y servidor. Los mensajes son genericos (BR-R5). */
const fromParser = <T, E>(max: number, parse: (raw: string) => Result<T, E>) =>
  z
    .string()
    .max(max)
    .transform((raw, ctx) => {
      const r = parse(raw);
      if (!r.ok) {
        ctx.addIssue({ code: 'custom', message: 'invalid' });
        return z.NEVER;
      }
      return r.value;
    });

export const postalCodeSchema = fromParser(16, PostalCode.parse);
export const phoneSchema = fromParser(32, PhoneES.parse);
export const emailSchema = fromParser(320, Email.parse);
/** Precio de enlace recibido como texto ("25", "25,50") -> ListingPrice. */
export const listingPriceSchema = fromParser(32, ListingPrice.parse);
