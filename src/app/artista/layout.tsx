import Link from 'next/link';
import type { ReactNode } from 'react';
import { getAppName } from '@/modules/platform/infrastructure/runtime';
import { requireArtistId } from '@/ui/server-context';
import { signOutAction } from '../acceso/actions';

const LINKS = [
  { href: '/artista', label: 'Panel', testId: 'nav-panel' },
  { href: '/artista/perfil', label: 'Perfil', testId: 'nav-perfil' },
  { href: '/artista/direccion', label: 'Dirección', testId: 'nav-direccion' },
  { href: '/artista/cobros', label: 'Cobros', testId: 'nav-cobros' },
  { href: '/artista/enlaces', label: 'Mis enlaces', testId: 'nav-enlaces' },
  { href: '/artista/pedidos', label: 'Pedidos', testId: 'nav-pedidos' },
  { href: '/artista/dinero', label: 'Dinero', testId: 'nav-dinero' },
] as const;

export default async function ArtistaLayout({ children }: { children: ReactNode }) {
  await requireArtistId(); // sin sesion valida: redirige a /acceso
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-3">
        <p className="text-lg font-semibold">{getAppName()}</p>
        <nav aria-label="Área del artista" className="flex flex-wrap gap-x-4 gap-y-2">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              data-testid={l.testId}
              className="inline-flex min-h-11 items-center font-medium text-[color:var(--color-acento)] underline"
            >
              {l.label}
            </Link>
          ))}
          <form action={signOutAction}>
            <button
              type="submit"
              data-testid="nav-salir"
              className="min-h-11 font-medium text-[color:var(--color-texto-suave)] underline"
            >
              Cerrar sesión
            </button>
          </form>
        </nav>
      </header>
      <main className="flex flex-col gap-6">{children}</main>
    </div>
  );
}
