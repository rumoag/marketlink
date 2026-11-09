import { getAppName } from '@/modules/platform/infrastructure/runtime';
import { AccesoForm } from './acceso-form';

export default async function AccesoPage({
  searchParams,
}: {
  searchParams: Promise<{ caducada?: string }>;
}) {
  const { caducada } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-12">
      <h1 data-testid="acceso-title" className="text-2xl font-semibold">
        Entrar en {getAppName()}
      </h1>
      <AccesoForm expired={caducada === '1'} />
    </main>
  );
}
