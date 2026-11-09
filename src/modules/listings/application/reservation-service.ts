import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { IdGenerator } from '@/modules/platform/application/ports';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import { markSold, type Listing } from '../domain/listing';
import { consume, release, tryReserve, type Reservation } from '../domain/reservation';
import type { ListingsRepos } from './ports';

export type ReservationServiceDeps = {
  readonly runner: TransactionRunner<ListingsRepos>;
  readonly ids: IdGenerator;
  readonly clock: Clock;
};

/**
 * Contrato para U3 (BR2-RS1 a RS5): reservar, liberar y vender. Cada operacion es una transaccion
 * que bloquea la fila del enlace, de modo que dos compradores no pueden ganar a la vez.
 */
export class ReservationService {
  constructor(private readonly deps: ReservationServiceDeps) {}

  async reserve(listingId: string, ttlMs: number): Promise<Result<Reservation, AppError>> {
    return this.deps.runner.run(systemScope, async (repos) => {
      const listing = await repos.listings.findByIdForUpdate(listingId);
      if (!listing) return err(appError('not_found'));
      const now = this.deps.clock.now();
      await repos.reservations.expireDue(listingId, now);
      const active = await repos.reservations.findActive(listingId, now);
      const created = tryReserve(listing, active ? [active] : [], ttlMs, now, this.deps.ids.uuid());
      if (!created.ok) return err(appError('conflict'));
      await repos.reservations.insert(created.value, now);
      return ok(created.value);
    });
  }

  /** BR2-RS5: liberar una reserva ya expirada, liberada o consumida no hace nada. */
  async release(reservationId: string): Promise<void> {
    await this.deps.runner.run(systemScope, async (repos) => {
      const reservation = await repos.reservations.findById(reservationId);
      if (!reservation) return;
      const listing = await repos.listings.findByIdForUpdate(reservation.listingId);
      if (!listing) return;
      const next = release(reservation);
      if (next !== reservation) await repos.reservations.update(next, this.deps.clock.now());
    });
  }

  /** BR2-RS4: consume la reserva activa y pasa el enlace a vendido (terminal). */
  async markSold(
    listingId: string,
    orderId: string | undefined,
  ): Promise<Result<Listing, AppError>> {
    return this.deps.runner.run(systemScope, async (repos) => {
      const listing = await repos.listings.findByIdForUpdate(listingId);
      if (!listing) return err(appError('not_found'));
      const now = this.deps.clock.now();
      const sold = markSold(listing, orderId, now);
      if (!sold.ok) return err(appError('conflict'));
      const active = await repos.reservations.findActive(listingId, now);
      if (active) await repos.reservations.update(consume(active), now);
      await repos.listings.save(sold.value);
      return ok(sold.value);
    });
  }
}
