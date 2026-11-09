import Link from 'next/link';

export default function EnlaceEnviadoPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4 py-12">
      <h1 data-testid="enviado-title" className="text-2xl font-semibold">
        Revisa tu correo
      </h1>
      <p data-testid="enviado-texto">
        Si el correo es válido, te hemos enviado un enlace para entrar. Caduca en 15 minutos y solo
        funciona una vez.
      </p>
      <p className="text-[color:var(--color-texto-suave)]">
        ¿No te llega? Mira en la carpeta de spam o{' '}
        <Link
          href="/acceso"
          data-testid="enviado-reintentar-link"
          className="font-medium text-[color:var(--color-acento)] underline"
        >
          pide otro enlace
        </Link>
        .
      </p>
    </main>
  );
}
