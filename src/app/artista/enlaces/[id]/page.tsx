import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/modules/kernel/domain/money';
import { MAX_PHOTOS } from '@/modules/listings/domain/photo-rules';
import { requireArtistId, requireServices } from '@/ui/server-context';
import { StatusBadge } from '@/ui/status-badge';
import {
  addPhotosAction,
  pauseListingAction,
  removePhotoAction,
  resumeListingAction,
  updateListingAction,
} from '../../actions';
import { EnlaceForm } from '../enlace-form';
import { AnadirFotos } from './anadir-fotos';
import { CopiarParaDM } from './copiar-para-dm';

const eurosForInput = (cents: number): string => (cents / 100).toFixed(2).replace('.', ',');

export default async function EnlaceDetallePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ creado?: string }>;
}) {
  const { id } = await params;
  const { creado } = await searchParams;
  const artistId = await requireArtistId();
  const services = requireServices();

  const view = await services.listings.getMine(artistId, id);
  if (!view.ok) notFound(); // enlace ajeno o inexistente: no se revela cual (BR2-LK8)
  const { listing, photos, dmText, reserved } = view.value;
  const sizes = await services.listings.getSizePresets();
  const sold = listing.status === 'vendido';

  return (
    <>
      <p>
        <Link href="/artista/enlaces" className="underline">
          ← Mis enlaces
        </Link>
      </p>
      <h1 data-testid="detalle-title" className="text-2xl font-semibold">
        {listing.title}
      </h1>
      {creado === '1' ? (
        <p
          role="status"
          data-testid="detalle-creado"
          className="rounded-md border border-[color:var(--color-acento)] p-3"
        >
          ¡Enlace creado! Cópialo y pégalo en tu mensaje directo.
        </p>
      ) : null}
      <p className="flex flex-wrap items-center gap-3">
        <span className="text-lg">
          {Money.format({ cents: listing.priceCents, currency: 'EUR' })}
        </span>
        <StatusBadge status={listing.status} reason={listing.pausedReason} />
        {sold ? (
          <Link href="/artista/pedidos" data-testid="detalle-ver-pedido" className="underline">
            Ver el pedido
          </Link>
        ) : null}
      </p>

      {listing.status === 'activo' || listing.status === 'pausado' ? (
        <div className="flex flex-wrap gap-3">
          {listing.status === 'activo' ? (
            <form action={pauseListingAction.bind(null, listing.id)}>
              <button
                type="submit"
                data-testid="enlace-pausar-button"
                className="min-h-11 rounded-md border px-4 font-medium"
              >
                Pausar enlace
              </button>
            </form>
          ) : (
            <form action={resumeListingAction.bind(null, listing.id)}>
              <button
                type="submit"
                data-testid="enlace-reanudar-button"
                className="min-h-11 rounded-md border px-4 font-medium"
              >
                Reanudar enlace
              </button>
            </form>
          )}
        </div>
      ) : null}

      <CopiarParaDM text={dmText} />

      <section aria-labelledby="fotos-titulo" className="flex flex-col gap-3">
        <h2 id="fotos-titulo" className="text-lg font-semibold">
          Fotos
        </h2>
        <ul className="flex flex-wrap gap-3" data-testid="detalle-fotos">
          {photos.map((p) => (
            <li key={p.id} className="flex flex-col items-start gap-2">
              {p.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.thumbUrl}
                  alt={`Foto ${p.position} de ${listing.title}`}
                  width={160}
                  height={160}
                  className="h-40 w-40 rounded object-cover"
                />
              ) : (
                <span className="flex h-40 w-40 items-center justify-center rounded border text-sm">
                  Sin imagen
                </span>
              )}
              {!sold && photos.length > 1 ? (
                <form action={removePhotoAction.bind(null, listing.id, p.id)}>
                  <button
                    type="submit"
                    data-testid={`foto-quitar-${p.position}`}
                    className="min-h-11 underline"
                  >
                    Quitar foto {p.position}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {!sold && photos.length < MAX_PHOTOS ? (
          <AnadirFotos
            action={addPhotosAction.bind(null, listing.id)}
            room={MAX_PHOTOS - photos.length}
          />
        ) : null}
      </section>

      {sold ? (
        <p data-testid="detalle-vendido">Este enlace está vendido y ya no se puede cambiar.</p>
      ) : (
        <section aria-labelledby="editar-titulo" className="flex flex-col gap-3">
          <h2 id="editar-titulo" className="text-lg font-semibold">
            Editar enlace
          </h2>
          <EnlaceForm
            mode="editar"
            action={updateListingAction.bind(null, listing.id)}
            sizes={sizes}
            locked={reserved}
            initial={{
              title: listing.title,
              description: listing.description,
              price: eurosForInput(listing.priceCents),
              declaredValue:
                listing.declaredValueCents === listing.priceCents
                  ? ''
                  : eurosForInput(listing.declaredValueCents),
              fragile: listing.fragile,
              size: listing.size,
              modality: listing.modality,
            }}
          />
        </section>
      )}
    </>
  );
}
