import { requireArtistId, requireServices } from '@/ui/server-context';
import { DireccionForm } from './direccion-form';

export default async function DireccionPage() {
  const artistId = await requireArtistId();
  const overview = await requireServices().accounts.getOverview(artistId);
  if (!overview.ok) throw new Error('overview_failed');
  const { address, artist } = overview.value;
  return (
    <>
      <h1 data-testid="direccion-title" className="text-2xl font-semibold">
        Dirección de envío
      </h1>
      <p className="text-[color:var(--color-texto-suave)]">
        Es la dirección desde la que sale (o se recoge) tu paquete. Solo la ven el operador y la
        empresa de transporte.
      </p>
      <DireccionForm
        street={address?.street ?? ''}
        number={address?.number ?? ''}
        floorDoor={address?.floorDoor ?? ''}
        postalCode={address?.postalCode ?? ''}
        city={address?.city ?? ''}
        province={address?.province ?? ''}
        phone={address?.phone ?? artist.phone ?? ''}
      />
    </>
  );
}
