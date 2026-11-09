import Link from 'next/link';
import { getAppName } from '@/modules/platform/infrastructure/runtime';
import { ConfirmarForm } from './confirmar-form';

export default async function ConfirmarPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string }>;
}) {
  const { token_hash: tokenHash } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-12">
      <h1 data-testid="confirmar-title" className="text-2xl font-semibold">
        Ya casi estás dentro
      </h1>
      {tokenHash ? (
        <>
          <p>Pulsa el botón para entrar. El enlace solo funciona una vez.</p>
          <ConfirmarForm tokenHash={tokenHash} productName={getAppName()} />
        </>
      ) : (
        <>
          <p data-testid="confirmar-sin-token">Este enlace no es válido.</p>
          <Link href="/acceso" className="font-medium text-[color:var(--color-acento)] underline">
            Pedir un enlace nuevo
          </Link>
        </>
      )}
    </main>
  );
}
