import Link from 'next/link';
import { Money } from '@/modules/kernel/domain/money';
import { formatMadrid } from '@/modules/kernel/domain/dates';
import { instantOf } from '@/modules/kernel/domain/clock';
import { trackingStatusText } from '@/modules/orders/domain/tracking-token';
import { requireArtistId, requireServices } from '@/ui/server-context';
import { confirmManualPaymentAction } from '../actions';

export const dynamic = 'force-dynamic';

const euros = (cents: number): string => Money.format({ cents, currency: 'EUR' });

/** Pedidos de la artista (BR3-AZ2): obra, fecha, estado, importes y solo la localidad de destino. */
export default async function PedidosPage() {
  const artistId = await requireArtistId();
  const services = requireServices();
  const rows = await services.artistOrders.execute(artistId);
  const pending = rows.filter((r) => r.awaitingConfirmation);

  return (
    <>
      <h1 data-testid="pedidos-title" className="text-2xl font-semibold">
        Pedidos
      </h1>

      {services.manualEnabled && pending.length > 0 ? (
        <section aria-label="Cobros por confirmar" className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">Cobros por confirmar</h2>
          <ul className="flex flex-col gap-3">
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                <span>
                  {r.title} · {euros(r.totalCents)}
                </span>
                <form action={confirmManualPaymentAction}>
                  <input type="hidden" name="orderId" value={r.id} />
                  <button
                    type="submit"
                    data-testid={`pedido-confirmar-${r.id}`}
                    className="min-h-11 rounded-md bg-[color:var(--color-acento)] px-5 py-2 font-medium text-[color:var(--color-acento-texto)]"
                  >
                    Confirmar cobro
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <p data-testid="pedidos-vacio">Todavía no tienes pedidos.</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="pedidos-lista">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-1 rounded-md border p-3"
              data-testid="pedido-fila"
            >
              <p className="font-medium">
                <Link
                  href={`/artista/pedidos/${r.id}`}
                  data-testid="pedido-ver"
                  className="underline"
                >
                  {r.title}
                </Link>
              </p>
              <p data-testid="pedido-estado">{trackingStatusText(r.status)}</p>
              <p>
                Obra {euros(r.workPriceCents)} · Envío {euros(r.shippingCents)} · Total{' '}
                {euros(r.totalCents)}
              </p>
              <p className="text-sm text-[color:var(--color-texto-suave)]">
                {formatMadrid(instantOf(r.createdAtMs))}
                {r.city ? ` · ${r.city}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
