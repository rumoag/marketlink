import { err, ok, type Result } from '@/modules/kernel/domain/result';
import { addMs, type Instant } from '@/modules/kernel/domain/clock';
import type { Listing } from './listing';

/** Reserva de la obra mientras alguien paga (BR2-RS1 a RS5). La usa U3. */
export type ReservationStatus = 'activa' | 'liberada' | 'consumida' | 'expirada';

export type Reservation = {
  readonly id: string;
  readonly listingId: string;
  readonly artistId: string;
  readonly status: ReservationStatus;
  readonly expiresAt: Instant;
};

export type ReservationError = 'already_reserved' | 'not_available';

/** Una reserva `activa` cuyo `expiresAt` ya paso no bloquea (BR2-RS3). */
export const isEffectivelyActive = (
  r: Pick<Reservation, 'status' | 'expiresAt'>,
  now: Instant,
): boolean => r.status === 'activa' && r.expiresAt > now;

/** Marca como expirada una reserva activa vencida; el resto queda igual. */
export const expireIfDue = (r: Reservation, now: Instant): Reservation =>
  r.status === 'activa' && r.expiresAt <= now ? { ...r, status: 'expirada' } : r;

/**
 * BR2-RS1: reserva sobre un enlace `activo` sin reserva vigente.
 * Devuelve la nueva reserva (id lo asigna quien persiste).
 */
export const tryReserve = (
  listing: Pick<Listing, 'id' | 'artistId' | 'status'>,
  existing: readonly Reservation[],
  ttlMs: number,
  now: Instant,
  id: string,
): Result<Reservation, ReservationError> => {
  if (listing.status !== 'activo') return err('not_available');
  if (existing.some((r) => r.listingId === listing.id && isEffectivelyActive(r, now))) {
    return err('already_reserved');
  }
  return ok({
    id,
    listingId: listing.id,
    artistId: listing.artistId,
    status: 'activa',
    expiresAt: addMs(now, ttlMs),
  });
};

/** BR2-RS5: liberar una reserva que ya no esta activa no hace nada. */
export const release = (r: Reservation): Reservation =>
  r.status === 'activa' ? { ...r, status: 'liberada' } : r;

/** BR2-RS4: markSold consume la reserva activa. */
export const consume = (r: Reservation): Reservation =>
  r.status === 'activa' ? { ...r, status: 'consumida' } : r;
