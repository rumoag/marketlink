import { err, ok, type Result } from './result';
import { instantOf, type Instant } from './clock';

/** BR-D1: ida y vuelta en UTC. */
export const formatISO = (t: Instant): string => new Date(t).toISOString();

export const parseISO = (s: string): Result<Instant, 'invalid_date'> => {
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? err('invalid_date') : ok(instantOf(ms));
};

const madridFormatter = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** BR-D3: presentacion en Europe/Madrid y formato es-ES (no invertible en la hora duplicada). */
export const formatMadrid = (t: Instant): string => madridFormatter.format(new Date(t));
