import { getAppName } from '@/modules/platform/infrastructure/runtime';

export default function HomePage() {
  const name = getAppName();
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-4 py-12">
      <h1 data-testid="home-title" className="text-3xl font-semibold">
        {name}
      </h1>
      <p data-testid="home-description" className="text-lg text-[color:var(--color-texto-suave)]">
        Un enlace para vender tus obras con el envio incluido. Muy pronto.
      </p>
    </main>
  );
}
