import { notFound } from 'next/navigation';
import { getAppName } from '@/modules/platform/infrastructure/runtime';
import { requireServices } from '@/ui/server-context';
import { OperatorEmailForm } from './forms';

export const dynamic = 'force-dynamic';

export default async function OperadorAccesoPage({
  searchParams,
}: {
  searchParams: Promise<{ enviado?: string }>;
}) {
  if (!requireServices().operator) notFound();
  const { enviado } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-12">
      <h1 data-testid="operador-acceso-title" className="text-2xl font-semibold">
        Panel de {getAppName()}
      </h1>
      <OperatorEmailForm sent={enviado === '1'} />
    </main>
  );
}
