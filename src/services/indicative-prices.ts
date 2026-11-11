import type { AccountsRepos } from '@/modules/accounts/application/ports';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { ShippingOptionsFinder } from '@/modules/checkout/application/shipping-options';
import type { ListingsRepos } from '@/modules/listings/application/ports';
import type { PackageSize } from '@/modules/listings/domain/listing';
import { artistScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';

/** Destino de ejemplo del precio orientativo (decision Q2 A del diseno funcional): Madrid. */
export const INDICATIVE_DESTINATION = '28001';
/** Valor declarado de ejemplo: el precio real depende del seguro de cada obra. */
const SAMPLE_DECLARED_CENTS = 10_000;

export type IndicativePrices = {
  /** «Desde X €» por origen (centimos), o ausente si no hay dato (US-054). */
  readonly punto: number | undefined;
  readonly recogida: number | undefined;
};

type Repos = ListingsRepos & AccountsRepos;

/**
 * US-054: precio orientativo de cada origen al crear un enlace. Solo lectura y con cache; si Packlink
 * no responde, devuelve `{}` y la pantalla muestra «—» sin impedir crear el enlace.
 */
export class IndicativePricing {
  constructor(
    private readonly deps: {
      readonly runner: TransactionRunner<Repos>;
      readonly finder: Pick<ShippingOptionsFinder, 'services'>;
    },
  ) {}

  async execute(
    artistId: string,
    size: PackageSize,
    correlationId: string,
  ): Promise<Result<IndicativePrices, AppError>> {
    const data = await this.deps.runner.run(artistScope(artistId), async (repos) => ({
      address: await repos.addresses.find(artistId),
      preset: (await repos.sizes.list()).find((s) => s.size === size),
    }));
    if (!data.address || !data.preset) return err(appError('not_found'));
    const services = await this.deps.finder.services(
      {
        sender: { postalCode: data.address.postalCode },
        parcel: {
          lengthCm: data.preset.lengthCm,
          widthCm: data.preset.widthCm,
          heightCm: data.preset.heightCm,
          weightKg: data.preset.weightKg,
        },
        declaredValueCents: SAMPLE_DECLARED_CENTS,
      },
      INDICATIVE_DESTINATION,
      correlationId,
    );
    if (!services.ok) return ok({ punto: undefined, recogida: undefined });
    const cheapest = (origin: 'punto' | 'recogida'): number | undefined => {
      const prices = services.value.filter((s) => s.modality === origin).map((s) => s.priceCents);
      return prices.length === 0 ? undefined : Math.min(...prices);
    };
    return ok({ punto: cheapest('punto'), recogida: cheapest('recogida') });
  }
}
