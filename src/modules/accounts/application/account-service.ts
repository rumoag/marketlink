import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import { validate } from '@/modules/kernel/domain/validation';
import type { Logger } from '@/modules/platform/application/ports';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import {
  artistScope,
  enforceLimit,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import {
  addressSchema,
  isProfileComplete,
  profileSchema,
  type Artist,
  type SenderAddress,
} from '../domain/artist';
import type { PayoutState, PayoutStatus, RequirementsHint } from '../domain/payout';
import type { AccountsRepos, PayoutProvider, PayoutStateApplier } from './ports';

export type NextStep = 'perfil' | 'direccion' | 'cobros' | 'enlace';

/** Estado de cobros visible para el artista: nunca incluye el identificador de la cuenta (BR2-CB8). */
export type PayoutView = {
  readonly status: PayoutStatus;
  readonly requirementsHint: RequirementsHint | undefined;
};

export type AccountOverview = {
  readonly artist: Artist;
  readonly address: SenderAddress | undefined;
  readonly profileComplete: boolean;
  readonly payout: PayoutView;
  readonly nextStep: NextStep;
};

export type AccountDeps = {
  readonly runner: TransactionRunner<AccountsRepos>;
  readonly limiter: Pick<RateLimiter, 'check'>;
  readonly payoutProvider: PayoutProvider;
  readonly applier: PayoutStateApplier;
  readonly clock: Clock;
  readonly logger: Logger;
  /** URL base publica de la aplicacion (para las URL de retorno del onboarding). */
  readonly appUrl: string;
};

const toPayoutView = (state: PayoutState): PayoutView => ({
  status: state.status,
  requirementsHint: state.requirementsHint,
});

/** Calcula el siguiente paso pendiente del panel (checklist de ChecklistPasos). */
export const computeNextStep = (
  profileComplete: boolean,
  hasAddress: boolean,
  payout: PayoutStatus,
): NextStep => {
  if (!profileComplete) return 'perfil';
  if (!hasAddress) return 'direccion';
  if (payout !== 'activo') return 'cobros';
  return 'enlace';
};

export class AccountService {
  constructor(private readonly deps: AccountDeps) {}

  async getOverview(artistId: string): Promise<Result<AccountOverview, AppError>> {
    return this.deps.runner.run(artistScope(artistId), async (repos) => {
      const artist = await repos.artists.findById(artistId);
      if (!artist) return err(appError('not_found'));
      const address = await repos.addresses.find(artistId);
      const payout = await repos.payouts.find(artistId);
      const state = payout?.state ?? { status: 'sin_iniciar' as const };
      const profileComplete = isProfileComplete(artist);
      return ok({
        artist,
        address,
        profileComplete,
        payout: toPayoutView(state),
        nextStep: computeNextStep(profileComplete, address !== undefined, state.status),
      });
    });
  }

  /** US-002. */
  async saveProfile(
    artistId: string,
    raw: unknown,
    correlationId: string,
  ): Promise<Result<Artist, AppError>> {
    const limited = await enforceLimit(this.deps.limiter, 'profile_save_artist', artistId, {
      failClosed: false,
      correlationId,
    });
    if (!limited.ok) return limited;
    const parsed = validate(profileSchema, raw);
    if (!parsed.ok) return parsed;
    return this.deps.runner.run(artistScope(artistId), async (repos) => {
      const existing = await repos.artists.findById(artistId);
      if (!existing) return err(appError('not_found'));
      return ok(await repos.artists.saveProfile(artistId, parsed.value, this.deps.clock.now()));
    });
  }

  /** US-003. */
  async saveSenderAddress(
    artistId: string,
    raw: unknown,
    correlationId: string,
  ): Promise<Result<SenderAddress, AppError>> {
    const limited = await enforceLimit(this.deps.limiter, 'profile_save_artist', artistId, {
      failClosed: false,
      correlationId,
    });
    if (!limited.ok) return limited;
    const parsed = validate(addressSchema, raw);
    if (!parsed.ok) return parsed;
    return this.deps.runner.run(artistScope(artistId), async (repos) => {
      const existing = await repos.artists.findById(artistId);
      if (!existing) return err(appError('not_found'));
      return ok(await repos.addresses.save(artistId, parsed.value, this.deps.clock.now()));
    });
  }

  /**
   * US-004: inicia o reanuda el onboarding y devuelve la URL del proveedor.
   * Fallo cerrado ante un almacen de contadores caido: cada llamada gasta cuota del proveedor.
   */
  async startPayoutOnboarding(
    artistId: string,
    correlationId: string,
  ): Promise<Result<{ url: string }, AppError>> {
    const limited = await enforceLimit(this.deps.limiter, 'payout_onboarding_artist', artistId, {
      failClosed: true,
      correlationId,
    });
    if (!limited.ok) return limited;

    // 1) Lectura: requisitos previos y cuenta existente (BR2-CB2).
    const snapshot = await this.deps.runner.run(artistScope(artistId), async (repos) => {
      const artist = await repos.artists.findById(artistId);
      const address = await repos.addresses.find(artistId);
      const payout = await repos.payouts.find(artistId);
      return { artist, address, payout };
    });
    if (!snapshot.artist) return err(appError('not_found'));
    if (!isProfileComplete(snapshot.artist) || !snapshot.address) {
      return err(appError('conflict'));
    }
    if (snapshot.payout?.state.status === 'activo') return err(appError('conflict'));

    // 2) Cuenta en el proveedor (clave de idempotencia determinista dentro del adaptador).
    let providerAccountId = snapshot.payout?.providerAccountId;
    if (providerAccountId === undefined) {
      const created = await this.deps.payoutProvider.createAccount({
        artistId,
        email: snapshot.artist.email,
      });
      if (!created.ok) return created;
      providerAccountId = created.value.providerAccountId;
      const accountId = providerAccountId;
      await this.deps.runner.run(artistScope(artistId), async (repos) => {
        await repos.payouts.lockForUpdate(artistId);
        await repos.payouts.setProviderAccount(artistId, accountId, this.deps.clock.now());
        const current = await repos.payouts.find(artistId);
        if (!current || current.state.status === 'sin_iniciar') {
          await repos.payouts.saveState(
            artistId,
            { status: 'onboarding_pendiente', requirementsHint: 'info_pendiente' },
            this.deps.clock.now(),
          );
        }
      });
    }

    // 3) Enlace de onboarding de un solo uso (BR2-CB3).
    const link = await this.deps.payoutProvider.createOnboardingLink(providerAccountId, {
      returnUrl: `${this.deps.appUrl}/artista/cobros`,
      refreshUrl: `${this.deps.appUrl}/artista/cobros`,
    });
    if (!link.ok) {
      this.deps.logger.warn('payout_onboarding_link_failed', {
        code: link.error.code,
        correlationId,
      });
      return link;
    }
    return ok({ url: link.value.url });
  }

  /**
   * Al volver del onboarding el webhook puede tardar: se consulta el estado al proveedor y se
   * aplica con el mismo caso de uso que el webhook (idempotente).
   */
  async refreshPayoutStatus(
    artistId: string,
    correlationId: string,
  ): Promise<Result<PayoutView, AppError>> {
    const record = await this.deps.runner.run(artistScope(artistId), (repos) =>
      repos.payouts.find(artistId),
    );
    if (!record?.providerAccountId) {
      return ok({ status: 'sin_iniciar', requirementsHint: undefined });
    }
    const snapshot = await this.deps.payoutProvider.getAccountSnapshot(record.providerAccountId);
    if (!snapshot.ok) {
      // El panel sigue funcionando con el ultimo estado conocido (U2-NFR-AV1).
      return ok(toPayoutView(record.state));
    }
    const applied = await this.deps.applier.applySnapshot(artistId, snapshot.value, correlationId);
    if (!applied.ok) return applied;
    const fresh = await this.deps.runner.run(artistScope(artistId), (repos) =>
      repos.payouts.find(artistId),
    );
    return ok(toPayoutView(fresh?.state ?? record.state));
  }
}
