import Link from 'next/link';
import { Money } from '@/modules/kernel/domain/money';
import { requireArtistId, requireServices } from '@/ui/server-context';
import { StatusBadge } from '@/ui/status-badge';
import { pauseListingAction, resumeListingAction } from '../actions';

export default async function EnlacesPage() {
  const artistId = await requireArtistId();
  const services = requireServices();
  const [list, overview] = await Promise.all([
    services.listings.listMine(artistId),
    services.accounts.getOverview(artistId),
  ]);
  if (!list.ok || !overview.ok) throw new Error('listing_failed');
  const canCreate = overview.value.nextStep === 'enlace';

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 data-testid="enlaces-title" className="text-2xl font-semibold">
          Mis enlaces
        </h1>
        <Link
          href="/artista/enlaces/nuevo"
          data-testid="enlaces-nuevo-link"
          className="inline-flex min-h-11 items-center rounded-md bg-[color:var(--color-acento)] px-4 font-medium text-[color:var(--color-acento-texto)]"
        >
          Nuevo enlace
        </Link>
      </div>

      {list.value.length === 0 ? (
        <p data-testid="enlaces-vacio">
          {canCreate
            ? 'Todavía no tienes enlaces. Crea el primero para vender una obra por mensaje directo.'
            : 'Aún no puedes crear enlaces: termina los pasos del panel (perfil, dirección y cobros).'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="enlaces-lista">
          {list.value.map(({ listing, photos }) => {
            const thumb = photos[0]?.thumbUrl;
            return (
              <li
                key={listing.id}
                className="flex flex-col gap-3 rounded-md border p-3"
                data-testid={`enlace-card-${listing.id}`}
              >
                <div className="flex items-center gap-3">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumb}
                      alt=""
                      width={64}
                      height={64}
                      loading="lazy"
                      className="h-16 w-16 rounded object-cover"
                    />
                  ) : (
                    <span aria-hidden="true" className="h-16 w-16 rounded border" />
                  )}
                  <div className="flex flex-1 flex-col gap-1">
                    <Link href={`/artista/enlaces/${listing.id}`} className="font-medium underline">
                      {listing.title}
                    </Link>
                    <span>{Money.format({ cents: listing.priceCents, currency: 'EUR' })}</span>
                    <StatusBadge status={listing.status} reason={listing.pausedReason} />
                    {listing.status === 'vendido' ? (
                      <Link
                        href="/artista/pedidos"
                        data-testid="enlace-ver-pedido"
                        className="underline"
                      >
                        Ver el pedido
                      </Link>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Link
                    href={`/artista/enlaces/${listing.id}`}
                    className="inline-flex min-h-11 items-center underline"
                  >
                    Abrir
                  </Link>
                  {listing.status === 'activo' ? (
                    <form action={pauseListingAction.bind(null, listing.id)}>
                      <button
                        type="submit"
                        data-testid="enlace-pausar-button"
                        className="min-h-11 underline"
                      >
                        Pausar
                      </button>
                    </form>
                  ) : null}
                  {listing.status === 'pausado' ? (
                    <form action={resumeListingAction.bind(null, listing.id)}>
                      <button
                        type="submit"
                        data-testid="enlace-reanudar-button"
                        className="min-h-11 underline"
                      >
                        Reanudar
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
