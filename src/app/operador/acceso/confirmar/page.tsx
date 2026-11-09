import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireServices } from '@/ui/server-context';
import { OperatorConfirmForm } from '../forms';

export const dynamic = 'force-dynamic';

export default async function OperadorConfirmarPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string }>;
}) {
  if (!requireServices().operator) notFound();
  const { token_hash: tokenHash } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-12">
      <h1 data-testid="operador-confirmar-title" className="text-2xl font-semibold">
        Ya casi estás dentro
      </h1>
      {tokenHash ? (
        <>
          <p>Pulsa el botón para continuar. El enlace solo funciona una vez.</p>
          <OperatorConfirmForm tokenHash={tokenHash} />
        </>
      ) : (
        <>
          <p data-testid="operador-sin-token">Este enlace no es válido.</p>
          <Link
            href="/operador/acceso"
            className="font-medium text-[color:var(--color-acento)] underline"
          >
            Pedir un enlace nuevo
          </Link>
        </>
      )}
    </main>
  );
}
