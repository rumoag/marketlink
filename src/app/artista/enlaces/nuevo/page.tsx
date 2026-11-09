import Link from 'next/link';
import { requireArtistId, requireServices } from '@/ui/server-context';
import { createListingAction } from '../../actions';
import { EnlaceForm } from '../enlace-form';

export default async function NuevoEnlacePage() {
  const artistId = await requireArtistId();
  const services = requireServices();
  const overview = await services.accounts.getOverview(artistId);
  if (!overview.ok) throw new Error('overview_failed');
  const canCreate = overview.value.nextStep === 'enlace';
  const sizes = await services.listings.getSizePresets();

  return (
    <>
      <h1 data-testid="nuevo-title" className="text-2xl font-semibold">
        Nuevo enlace de venta
      </h1>
      {canCreate ? (
        <EnlaceForm
          mode="crear"
          action={createListingAction}
          sizes={sizes}
          initial={{
            title: '',
            description: '',
            price: '',
            declaredValue: '',
            fragile: false,
            size: '',
            modality: '',
          }}
        />
      ) : (
        <p data-testid="nuevo-bloqueado">
          Para crear un enlace primero termina los pasos del{' '}
          <Link href="/artista" className="font-medium underline">
            panel
          </Link>{' '}
          (perfil, dirección y cobros activos).
        </p>
      )}
    </>
  );
}
