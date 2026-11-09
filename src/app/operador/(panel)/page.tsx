import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requestInfo, requireOperator, requireServices } from '@/ui/server-context';

export const dynamic = 'force-dynamic';

/** Resumen: cada bloque degrada por separado (NFR-U6-22). */
export default async function OperadorResumenPage() {
  const actor = await requireOperator();
  const operator = requireServices().operator;
  if (!operator) notFound();
  const { correlationId } = await requestInfo();
  const result = await operator.summary.execute(actor, correlationId);
  const counts = result.ok ? result.value.counts : ({ ok: false } as const);

  const cards = [
    { key: 'stuck', label: 'Pedidos atascados', href: '/operador/pedidos?atascados=1' },
    { key: 'unpaidDrafts', label: 'Borradores sin pagar', href: '/operador/borradores' },
    { key: 'openFlags', label: 'Incidencias abiertas', href: '/operador/pedidos?atascados=1' },
  ] as const;

  return (
    <>
      <h1 data-testid="op-resumen-title" className="text-2xl font-semibold">
        Resumen
      </h1>
      <section aria-label="Contadores" className="grid gap-3 sm:grid-cols-3">
        {cards.map((c) => (
          <Link
            key={c.key}
            href={c.href}
            data-testid={`op-card-${c.key}`}
            className="flex flex-col gap-1 rounded-md border p-4"
          >
            <span className="text-sm text-[color:var(--color-texto-suave)]">{c.label}</span>
            <span className="text-2xl font-semibold">
              {counts.ok ? counts.value[c.key] : 'No disponible ahora'}
            </span>
          </Link>
        ))}
      </section>
    </>
  );
}
