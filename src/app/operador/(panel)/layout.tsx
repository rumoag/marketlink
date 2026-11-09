import Link from 'next/link';
import type { ReactNode } from 'react';
import { getAppName } from '@/modules/platform/infrastructure/runtime';
import { requireOperator } from '@/ui/server-context';
import { signOutOperatorAction } from '../acceso/actions';

const LINKS = [
  { href: '/operador', label: 'Resumen', testId: 'op-nav-resumen' },
  { href: '/operador/pedidos', label: 'Pedidos', testId: 'op-nav-pedidos' },
  { href: '/operador/borradores', label: 'Borradores', testId: 'op-nav-borradores' },
  { href: '/operador/metricas', label: 'Métricas', testId: 'op-nav-metricas' },
  { href: '/operador/salud', label: 'Salud', testId: 'op-nav-salud' },
  { href: '/operador/tamanos', label: 'Tamaños', testId: 'op-nav-tamanos' },
] as const;

export const dynamic = 'force-dynamic';

export default async function OperadorLayout({ children }: { children: ReactNode }) {
  const operator = await requireOperator(); // sin sesion completa: redirige al acceso
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-3">
        <p className="text-lg font-semibold">Panel de {getAppName()}</p>
        <p data-testid="op-email" className="text-sm text-[color:var(--color-texto-suave)]">
          {operator.email}
        </p>
        <nav aria-label="Panel del operador" className="flex flex-wrap gap-x-4 gap-y-2">
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
          <form action={signOutOperatorAction}>
            <button
              type="submit"
              data-testid="op-salir"
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
