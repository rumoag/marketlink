'use client';

/** Error de pagina: mensaje comprensible, sin detalles tecnicos (U1-NFR-US3, SECURITY-09). */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-4 py-12">
      <h1 data-testid="error-title" className="text-2xl font-semibold">
        Algo no ha ido bien
      </h1>
      <p className="text-[color:var(--color-texto-suave)]">
        Ha ocurrido un error. Prueba de nuevo en unos instantes.
      </p>
      <button
        type="button"
        data-testid="error-retry-button"
        onClick={() => reset()}
        className="w-fit rounded-md bg-[color:var(--color-acento)] px-4 py-2 font-medium text-[color:var(--color-acento-texto)]"
      >
        Reintentar
      </button>
    </main>
  );
}
