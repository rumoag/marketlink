import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/modules/kernel/domain/money';
import { ORDER_STATUSES, type OrderStatus } from '@/modules/orders/domain/order';
import { STUCK_TEXT, packlinkShipmentsUrl } from '@/modules/operator/domain/stuck';
import { requestInfo, requireOperator, requireServices } from '@/ui/server-context';

export const dynamic = 'force-dynamic';

const euros = (cents: number): string => Money.format({ cents, currency: 'EUR' });
const day = (ms: number): string =>
  new Date(ms).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
const parseDay = (v: string | undefined): number | undefined => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : t;
};

type Search = {
  estado?: string;
  artista?: string;
  desde?: string;
  hasta?: string;
  atascados?: string;
  pagina?: string;
};

export default async function OperadorPedidosPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const actor = await requireOperator();
  const operator = requireServices().operator;
  if (!operator) notFound();
  const { correlationId } = await requestInfo();
  const q = await searchParams;

  const status = (ORDER_STATUSES as readonly string[]).includes(q.estado ?? '')
    ? (q.estado as OrderStatus)
    : undefined;
  const from = parseDay(q.desde);
  const toDay = parseDay(q.hasta);
  const filter = {
    ...(status ? { status } : {}),
    ...(q.artista && /^[0-9a-f-]{36}$/i.test(q.artista) ? { artistId: q.artista } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(toDay !== undefined ? { to: toDay + 24 * 3_600_000 } : {}),
    ...(q.atascados === '1' ? { stuckOnly: true } : {}),
  };
  const page = Math.max(1, Number(q.pagina) || 1);
  const [result, artists] = await Promise.all([
    operator.listOrders.execute(actor, filter, page, correlationId),
    operator.listOrders.artists(actor),
  ]);

  const link = (p: number): string => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...q, pagina: String(p) })) if (v) params.set(k, v);
    return `/operador/pedidos?${params.toString()}`;
  };

  return (
    <>
      <h1 data-testid="op-pedidos-title" className="text-2xl font-semibold">
        Pedidos
      </h1>
      <form method="get" className="grid gap-3 sm:grid-cols-5" aria-label="Filtros">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Estado</span>
          <select
            name="estado"
            defaultValue={q.estado ?? ''}
            data-testid="op-filtro-estado"
            className="min-h-11 rounded-md border bg-transparent px-2"
          >
            <option value="">Todos</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Artista</span>
          <select
            name="artista"
            defaultValue={q.artista ?? ''}
            data-testid="op-filtro-artista"
            className="min-h-11 rounded-md border bg-transparent px-2"
          >
            <option value="">Todas</option>
            {artists.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Desde</span>
          <input
            type="date"
            name="desde"
            defaultValue={q.desde ?? ''}
            data-testid="op-filtro-desde"
            className="min-h-11 rounded-md border bg-transparent px-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Hasta</span>
          <input
            type="date"
            name="hasta"
            defaultValue={q.hasta ?? ''}
            data-testid="op-filtro-hasta"
            className="min-h-11 rounded-md border bg-transparent px-2"
          />
        </label>
        <label className="flex min-h-11 items-end gap-2">
          <input
            type="checkbox"
            name="atascados"
            value="1"
            defaultChecked={q.atascados === '1'}
            data-testid="op-filtro-atascados"
          />
          <span className="font-medium">Solo atascados</span>
        </label>
        <button
          type="submit"
          data-testid="op-filtrar"
          className="min-h-11 w-fit rounded-md border px-4 font-medium"
        >
          Filtrar
        </button>
      </form>

      {!result.ok ? (
        <p role="alert" data-testid="op-pedidos-error">
          No se puede cargar la lista ahora. Prueba de nuevo en unos minutos.
        </p>
      ) : result.value.items.length === 0 ? (
        <p data-testid="op-pedidos-vacio">No hay pedidos con estos filtros.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left" data-testid="op-pedidos-tabla">
              <caption className="sr-only">Pedidos</caption>
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Obra</th>
                  <th scope="col">Artista</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Total</th>
                  <th scope="col">Atención</th>
                  <th scope="col">Packlink</th>
                </tr>
              </thead>
              <tbody>
                {result.value.items.map((o) => (
                  <tr key={o.id} data-testid="op-pedido-fila" className="border-t align-top">
                    <td>{day(o.createdAt)}</td>
                    <td>
                      <Link
                        href={`/operador/pedidos/${o.id}`}
                        data-testid="op-pedido-ver"
                        className="font-medium underline"
                      >
                        {o.title}
                      </Link>
                    </td>
                    <td>{o.artistName}</td>
                    <td>{o.status}</td>
                    <td>{euros(o.totalCents)}</td>
                    <td data-testid="op-pedido-atasco">{o.stuck ? STUCK_TEXT[o.stuck] : ''}</td>
                    <td>
                      {o.providerRef ? (
                        <>
                          <a
                            href={packlinkShipmentsUrl()}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline"
                          >
                            Abrir Packlink
                          </a>{' '}
                          <code data-testid="op-pedido-ref">{o.providerRef}</code>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="Paginación" className="flex items-center gap-4">
            {result.value.page > 1 ? (
              <Link href={link(result.value.page - 1)}>Anterior</Link>
            ) : null}
            <span data-testid="op-pagina">
              Página {result.value.page} de {result.value.pages} ({result.value.total} pedidos)
            </span>
            {result.value.page < result.value.pages ? (
              <Link href={link(result.value.page + 1)}>Siguiente</Link>
            ) : null}
          </nav>
        </>
      )}
    </>
  );
}
