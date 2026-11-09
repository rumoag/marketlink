import { requireArtistId, requireServices } from '@/ui/server-context';
import { BizumForm } from './bizum-form';
import { PerfilForm } from './perfil-form';

export default async function PerfilPage() {
  const artistId = await requireArtistId();
  const overview = await requireServices().accounts.getOverview(artistId);
  if (!overview.ok) throw new Error('overview_failed');
  const { artist } = overview.value;
  const bizumPhone = (await requireServices().contacts.get(artistId)) ?? '';
  return (
    <>
      <h1 data-testid="perfil-title" className="text-2xl font-semibold">
        Tu perfil
      </h1>
      <PerfilForm
        artisticName={artist.artisticName ?? ''}
        instagram={artist.instagram ? `@${artist.instagram}` : ''}
        phone={artist.phone ?? ''}
      />
      <BizumForm bizumPhone={bizumPhone} />
    </>
  );
}
