import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { PayoutStateApplier } from '@/modules/accounts/application/ports';
import { applyAccountEvent, type AccountSnapshot } from '@/modules/accounts/domain/payout';
import type { Logger } from '@/modules/platform/application/ports';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import type { AppRepos } from './repos';

export type AppliedSnapshot = {
  readonly artistId: string;
  readonly applied: boolean;
  readonly becameRestricted: boolean;
  readonly pausedListings: number;
};

/**
 * Caso de uso de coordinacion (P2-CON-4): aplica un resumen de cuenta al estado de cobros y, si
 * pasa a `restringido`, pausa los enlaces activos del artista en la misma transaccion (BR2-CB10).
 * Idempotente y tolerante al desorden de eventos (P-U2-11, P-U2-12).
 */
export class ApplyAccountEventUseCase implements PayoutStateApplier {
  constructor(
    private readonly deps: {
      readonly runner: TransactionRunner<AppRepos>;
      readonly clock: Clock;
      readonly logger: Logger;
    },
  ) {}

  /** Entrada por artista (al volver del onboarding). */
  async applySnapshot(
    artistId: string,
    snapshot: AccountSnapshot,
    correlationId: string,
  ): Promise<Result<{ becameRestricted: boolean }, AppError>> {
    const r = await this.applyForArtist(artistId, snapshot);
    if (r.ok && r.value.becameRestricted) {
      this.deps.logger.warn('payout_restricted', {
        artistId,
        paused: r.value.pausedListings,
        correlationId,
      });
    }
    return r.ok ? ok({ becameRestricted: r.value.becameRestricted }) : r;
  }

  /** Entrada desde el webhook: se localiza al artista por el identificador de cuenta. */
  async applyByProviderAccount(
    providerAccountId: string,
    snapshot: AccountSnapshot,
  ): Promise<Result<AppliedSnapshot | null, AppError>> {
    const found = await this.deps.runner.run(systemScope, (repos) =>
      repos.payouts.findByProviderAccountId(providerAccountId),
    );
    // Un evento de una cuenta que no es nuestra no tiene efecto (se marca como procesado).
    if (!found) return ok(null);
    return this.applyForArtist(found.artistId, snapshot);
  }

  private async applyForArtist(
    artistId: string,
    snapshot: AccountSnapshot,
  ): Promise<Result<AppliedSnapshot, AppError>> {
    return this.deps.runner.run(systemScope, async (repos) => {
      const record = await repos.payouts.lockForUpdate(artistId);
      const result = applyAccountEvent(record.state, snapshot);
      if (!result.applied) {
        return ok({ artistId, applied: false, becameRestricted: false, pausedListings: 0 });
      }
      const now = this.deps.clock.now();
      await repos.payouts.saveState(artistId, result.state, now);
      let pausedListings = 0;
      if (result.becameRestricted) {
        pausedListings = await repos.listings.pauseActiveForRestriction(artistId, now);
      }
      return ok({
        artistId,
        applied: true,
        becameRestricted: result.becameRestricted,
        pausedListings,
      });
    });
  }
}

/** Error generico si el proveedor devuelve algo inesperado al reducir el evento. */
export const invalidEvent = (): Result<never, AppError> => err(appError('validation'));
