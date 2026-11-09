import type { AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { PhoneES } from '@/modules/kernel/domain/formats';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import { appError } from '@/modules/kernel/domain/app-error';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import {
  artistScope,
  enforceLimit,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import type { OrdersRepos } from './ports';

/**
 * Telefono de Bizum de la artista (Q5a A): campo opcional que solo se muestra a compradoras en el
 * modo manual. Distinto del telefono del perfil, que nunca se muestra.
 */
export class ArtistContactService {
  constructor(
    private readonly deps: {
      readonly runner: TransactionRunner<OrdersRepos>;
      readonly limiter: Pick<RateLimiter, 'check'>;
      readonly clock: Clock;
    },
  ) {}

  get(artistId: string): Promise<string | undefined> {
    return this.deps.runner.run(artistScope(artistId), (repos) =>
      repos.contacts.findBizumPhone(artistId),
    );
  }

  /** Vacio = quitar el numero. */
  async save(
    artistId: string,
    rawPhone: string,
    correlationId: string,
  ): Promise<Result<void, AppError>> {
    const limited = await enforceLimit(this.deps.limiter, 'profile_save_artist', artistId, {
      failClosed: false,
      correlationId,
    });
    if (!limited.ok) return limited;

    const trimmed = rawPhone.trim();
    let phone: string | undefined;
    if (trimmed !== '') {
      const parsed = PhoneES.parse(trimmed);
      if (!parsed.ok) {
        return err(
          appError('validation', { details: [{ field: 'bizumPhone', reason: 'invalido' }] }),
        );
      }
      phone = parsed.value;
    }
    await this.deps.runner.run(artistScope(artistId), (repos) =>
      repos.contacts.saveBizumPhone(artistId, phone, this.deps.clock.now()),
    );
    return ok(undefined);
  }
}
