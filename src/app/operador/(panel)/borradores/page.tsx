import Link from 'next/link';
import { notFound } from 'next/navigation';
import { packlinkShipmentsUrl } from '@/modules/operator/domain/stuck';
import { requestInfo, requireOperator, requireServices } from '@/ui/server-context';

export const dynamic = 'force-dynamic';

/** US-029: borradores que esperan a que pagues la etiqueta en Packlink PRO. */
export default async function OperadorBorradoresPage() {
  const actor = await requireOperator();
  const operator = requireServices().operator;
  if (!operator) notFound();
  const { correlationId } = await requestInfo();
  const result = await operator.drafts.execute(actor, correlationId);
  return (
    <>
      <h1 data-testid="op-borradores-title" className="text-2xl font-semibold">
        Borradores sin pagar
      </h1>
      <p>
        <a
          href={packlinkShipmentsUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline"
        >
          Abrir Packlink PRO
        </a>{' '}
        y busca la referencia para pagar la etiqueta.
      </p>
      {!result.ok ? (
        <p role="alert">No se puede cargar la lista ahora. Prueba de nuevo en unos minutos.</p>
      ) : result.value.drafts.length === 0 ? (
        <p data-testid="op-borradores-vacio">No hay borradores pendientes de pago.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {result.value.drafts.map((d) => (
            <li key={d.orderId} data-testid="op-borrador" className="rounded-md border p-3">
              <Link href={`/operador/pedidos/${d.orderId}`} className="font-medium underline">
                {d.title}
              </Link>
              <br />
              Antigüedad: <span data-testid="op-borrador-edad">{d.ageHours} h</span>
              {d.ageHours >= 24 ? ' · ⚠ lleva más de 24 horas' : ''}
              {d.providerRef ? (
                <>
                  {' '}
                  · Referencia: <code>{d.providerRef}</code>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
