/** Instante en UTC como milisegundos desde la epoca (BR-D1). */
export type Instant = number & { readonly __brand: 'Instant' };

export const instantOf = (epochMs: number): Instant => epochMs as Instant;

/** Reloj inyectable (BR-D4). */
export interface Clock {
  now(): Instant;
}

export const systemClock: Clock = { now: () => instantOf(Date.now()) };

export const addMs = (t: Instant, ms: number): Instant => instantOf(t + ms);

export const MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

/** Fuente de aleatoriedad inyectable: devuelve un numero en [0, 1). */
export interface Random {
  next(): number;
}

export const systemRandom: Random = { next: () => Math.random() };
