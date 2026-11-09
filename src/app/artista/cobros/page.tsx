import Link from 'next/link';
import type { PayoutStatus, RequirementsHint } from '@/modules/accounts/domain/payout';
import { requestInfo, requireArtistId, requireServices } from '@/ui/server-context';
import { CobrosForm } from './cobros-form';

const TITLES: Record<PayoutStatus, string> = {
  sin_iniciar: 'Cobros sin activar',
  onboarding_pendiente: 'Activación en curso',
  activo: 'Cobros activos',
  restringido: 'Cobros restringidos',
};

const HINTS: Record<RequirementsHint, string> = {
  info_pendiente: 'Faltan datos por completar en Stripe. Continúa el proceso para terminar.',
  verificacion_pendiente:
    'Stripe está verificando tu información. Puede tardar un poco; no tienes que hacer nada más.',
  deshabilitada: 'Stripe ha restringido tu cuenta. Entra en su asistente para ver qué necesita.',
};

export default async function CobrosPage() {
  const artistId = await requireArtistId();
  const { correlationId } = await requestInfo();
  const services = requireServices();

  // Al volver del onboarding el webhook puede tardar: se consulta el estado al proveedor.
  const overview = await services.accounts.getOverview(artistId);
  if (!overview.ok) throw new Error('overview_failed');
  let payout = overview.value.payout;
  if (payout.status === 'onboarding_pendiente' || payout.status === 'restringido') {
    const refreshed = await services.accounts.refreshPayoutStatus(artistId, correlationId);
    if (refreshed.ok) payout = refreshed.value;
  }

  const ready = overview.value.profileComplete && overview.value.address !== undefined;
  const label = payout.status === 'sin_iniciar' ? 'Activar cobros' : 'Continuar con Stripe';

  return (
    <>
      <h1 data-testid="cobros-title" className="text-2xl font-semibold">
        Tus cobros
      </h1>
      <section
        aria-labelledby="estado-cobros"
        className="flex flex-col gap-3 rounded-md border p-4"
      >
        <h2 id="estado-cobros" data-testid="cobros-estado-text" className="text-lg font-semibold">
          {TITLES[payout.status]}
        </h2>
        {payout.status === 'activo' ? (
          <p>
            Ya puedes crear enlaces de venta. Cuando vendas, recibirás el dinero cuando el comprador
            reciba la obra.
          </p>
        ) : payout.requirementsHint ? (
          <p data-testid="cobros-pista">{HINTS[payout.requirementsHint]}</p>
        ) : (
          <p>
            Usamos Stripe para pagarte de forma segura. Tendrás que verificar tu identidad y tu
            cuenta bancaria.
          </p>
        )}
        {payout.status === 'restringido' ? (
          <p role="alert">
            Hemos pausado tus enlaces. Cuando tus cobros vuelvan a estar activos podrás reanudarlos
            tú mismo.
          </p>
        ) : null}
      </section>

      {!ready ? (
        <p data-testid="cobros-faltan-requisitos">
          Antes de activar los cobros completa tu{' '}
          <Link href="/artista/perfil" className="font-medium underline">
            perfil
          </Link>{' '}
          y tu{' '}
          <Link href="/artista/direccion" className="font-medium underline">
            dirección de envío
          </Link>
          .
        </p>
      ) : null}
      <CobrosForm label={label} disabled={!ready || payout.status === 'activo'} />
    </>
  );
}
