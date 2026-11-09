import Link from 'next/link';
import { computeNextStep, type NextStep } from '@/modules/accounts/application/account-service';
import { requireArtistId, requireServices } from '@/ui/server-context';

const STEPS: readonly { key: NextStep; label: string; href: string; testId: string }[] = [
  {
    key: 'perfil',
    label: 'Completa tu perfil',
    href: '/artista/perfil',
    testId: 'panel-paso-perfil',
  },
  {
    key: 'direccion',
    label: 'Añade tu dirección de envío',
    href: '/artista/direccion',
    testId: 'panel-paso-direccion',
  },
  {
    key: 'cobros',
    label: 'Activa tus cobros',
    href: '/artista/cobros',
    testId: 'panel-paso-cobros',
  },
  {
    key: 'enlace',
    label: 'Crea tu primer enlace',
    href: '/artista/enlaces/nuevo',
    testId: 'panel-paso-enlace',
  },
];

export default async function PanelPage() {
  const artistId = await requireArtistId();
  const services = requireServices();
  const overview = await services.accounts.getOverview(artistId);
  if (!overview.ok) throw new Error('overview_failed');
  const { artist, address, payout, profileComplete, nextStep } = overview.value;
  // El ultimo paso se da por hecho en cuanto existe algun enlace.
  let hasListing = false;
  if (payout.status === 'activo') {
    const mine = await services.listings.listMine(artistId);
    hasListing = mine.ok && mine.value.length > 0;
  }
  const done = {
    perfil: profileComplete,
    direccion: address !== undefined,
    cobros: payout.status === 'activo',
    enlace: hasListing,
  } as const;
  const next = computeNextStep(profileComplete, address !== undefined, payout.status);

  return (
    <>
      <h1 data-testid="panel-title" className="text-2xl font-semibold">
        Hola{artist.artisticName ? `, ${artist.artisticName}` : ''}
      </h1>

      {payout.status === 'restringido' ? (
        <p
          role="alert"
          data-testid="panel-cobros-restringidos"
          className="rounded-md border border-red-700 p-3"
        >
          Tus cobros están restringidos y hemos pausado tus enlaces. Revisa{' '}
          <Link href="/artista/cobros" className="font-medium underline">
            el estado de tus cobros
          </Link>{' '}
          para reactivarlos.
        </p>
      ) : null}

      <ol className="flex flex-col gap-3" aria-label="Pasos para empezar a vender">
        {STEPS.map((step) => {
          const isDone = done[step.key];
          const isNext = step.key === next && !isDone;
          return (
            <li
              key={step.key}
              className="flex items-center gap-3 rounded-md border p-3"
              data-testid={step.testId}
            >
              <span aria-hidden="true">{isDone ? '✔' : isNext ? '➜' : '○'}</span>
              <span className="flex-1">
                {step.label}
                <span className="sr-only">
                  {isDone ? ' (hecho)' : isNext ? ' (siguiente paso)' : ' (pendiente)'}
                </span>
              </span>
              {!isDone ? (
                <Link
                  href={step.href}
                  className="inline-flex min-h-11 items-center font-medium text-[color:var(--color-acento)] underline"
                >
                  {isNext ? 'Continuar' : 'Abrir'}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="sr-only" data-testid="panel-siguiente-paso">
        {nextStep}
      </p>
    </>
  );
}
