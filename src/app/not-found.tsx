import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-4 py-12">
      <h1 data-testid="not-found-title" className="text-2xl font-semibold">
        No hemos encontrado lo que buscas
      </h1>
      <Link
        href="/"
        data-testid="not-found-home-link"
        className="w-fit font-medium text-[color:var(--color-acento)] underline"
      >
        Volver al inicio
      </Link>
    </main>
  );
}
