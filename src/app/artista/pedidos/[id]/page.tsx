import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/modules/kernel/domain/money';
import { requireArtistId, requireServices } from '@/ui/server-context';
import { chooseDraftPickupAction } from '../../actions';

export const dynamic = 'force-dynamic';

const euros = (cents: number): string => Money.format({ cents, currency: 'EUR' });

const PICKUP_MESSAGES: Record<string, string> = {
  ok: 'Recogida elegida. Estamos preparando la etiqueta.',
  no: 'Esa franja ya no está disponible; hemos actualizado las opciones.',
  error: 'No hemos podido guardar la elección. Prueba de nuevo.',
};

/** Detalle del pedido de la artista (US-036, US-031, US-032, US-030, US-034). */
export default async function PedidoDetallePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ recogida?: string }>;
}) {
  const { id } = await params;
  const { recogida } = await searchParams;
  const artistId = await requireArtistId();
  const result = await requireServices().artistOrder.execute(artistId, id);
  if (!result.ok) notFound(); // pedido ajeno o inexistente: misma respuesta

  const o = result.value;
  const money = await requireServices().orderMoney.execute(artistId, o.id, o.status);
  const waitingPickup = o.next.code === 'elegir_recogida';

  return (
    <>
      <p>
        <Link href="/artista/pedidos" className="underline">
          ← Pedidos
        </Link>
      </p>
      <h1 data-testid="pedido-titulo" className="text-2xl font-semibold">
        {o.title}
      </h1>
      <p
        data-testid="pedido-siguiente"
        className="rounded-md border border-[color:var(--color-acento)] p-3 text-lg font-medium"
      >
        {o.next.text}
      </p>
      {recogida && PICKUP_MESSAGES[recogida] ? (
        <p role="status" data-testid="pedido-recogida-mensaje" className="rounded-md border p-3">
          {PICKUP_MESSAGES[recogida]}
        </p>
      ) : null}
      {o.failedNotifications > 0 ? (
        <p
          role="alert"
          data-testid="pedido-aviso-email"
          className="rounded-md border border-red-700 p-3"
        >
          No hemos podido avisarte por email: tu pedido está en esta pantalla.
        </p>
      ) : null}

      <section aria-label="Importes" className="flex flex-col gap-1">
        <p className="flex justify-between">
          <span>Obra</span>
          <span>{euros(o.workPriceCents)}</span>
        </p>
        <p className="flex justify-between">
          <span>Envío</span>
          <span>{euros(o.shippingCents)}</span>
        </p>
        <p className="flex justify-between text-lg font-semibold">
          <span>Total</span>
          <span>{euros(o.totalCents)}</span>
        </p>
      </section>

      <section aria-label="Dinero del pedido" className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">Dinero del pedido</h2>
        {o.status === 'liquidado' ? (
          <p data-testid="pedido-dinero">
            Cobro liberado: {euros(money.settlement?.amountCents ?? o.workPriceCents)} ya están en
            tu saldo.
          </p>
        ) : money.reason ? (
          <p data-testid="pedido-dinero">
            {euros(money.settlement?.amountCents ?? o.workPriceCents)} en retención · {money.reason}
          </p>
        ) : (
          <p data-testid="pedido-dinero">Sin dinero retenido en este pedido.</p>
        )}
        {money.refunds.filter((r) => r.status === 'hecho').length > 0 ? (
          <p data-testid="pedido-reembolsos">
            Reembolsado:{' '}
            {euros(
              money.refunds
                .filter((r) => r.status === 'hecho')
                .reduce((s, r) => s + r.amountCents, 0),
            )}
          </p>
        ) : null}
      </section>

      <section aria-label="Destino" className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">Destino</h2>
        {o.destination.full ? (
          <p data-testid="pedido-direccion">{o.destination.full}</p>
        ) : (
          <p data-testid="pedido-localidad">{o.destination.city ?? 'Sin datos'}</p>
        )}
      </section>

      {waitingPickup ? (
        <form
          action={chooseDraftPickupAction.bind(null, o.id)}
          className="flex flex-col gap-3"
          aria-label="Elegir recogida"
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xl font-semibold">Elige la recogida</legend>
            {o.pickupOptions.map((p) => (
              <label key={p.id} className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="pickup"
                  value={p.id}
                  required
                  data-testid={`recogida-${p.id}`}
                />
                <span>
                  {p.date} · {p.slot}
                </span>
              </label>
            ))}
          </fieldset>
          <button
            type="submit"
            data-testid="recogida-confirmar-button"
            className="min-h-11 w-fit rounded-md bg-[color:var(--color-acento)] px-5 py-2 font-medium text-[color:var(--color-acento-texto)]"
          >
            Confirmar recogida
          </button>
        </form>
      ) : null}

      {o.modality === 'punto' && o.hasLabel ? (
        <section aria-label="Puntos de entrega" className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold">Puntos de entrega cercanos</h2>
          {o.dropoffPoints && o.dropoffPoints.length > 0 ? (
            <ul data-testid="pedido-puntos" className="flex flex-col gap-2">
              {o.dropoffPoints.map((d) => (
                <li key={`${d.name}-${d.address}`}>
                  <strong>{d.name}</strong> · {d.address} ({d.schedule})
                </li>
              ))}
            </ul>
          ) : (
            <p data-testid="pedido-sin-puntos">
              Busca un punto de entrega en la web de tu transportista.
            </p>
          )}
        </section>
      ) : null}

      {o.modality === 'recogida' && o.pickupChosen ? (
        <p data-testid="pedido-recogida-elegida">
          Recogida: {o.pickupChosen.date} · {o.pickupChosen.slot}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {o.hasLabel ? (
          <a
            href={`/artista/pedidos/${o.id}/etiqueta`}
            data-testid="pedido-etiqueta-link"
            className="inline-flex min-h-11 items-center rounded-md border px-4 font-medium"
          >
            Descargar etiqueta
          </a>
        ) : null}
        {o.invoiceAvailable ? (
          <a
            href={`/artista/pedidos/${o.id}/factura`}
            data-testid="pedido-factura-link"
            className="inline-flex min-h-11 items-center rounded-md border px-4 font-medium"
          >
            Descargar borrador de factura
          </a>
        ) : null}
      </div>
      {o.hasLabel ? (
        <p className="text-sm text-[color:var(--color-texto-suave)]">
          El enlace de la etiqueta caduca en 5 minutos. Si caduca, vuelve a pulsar el botón.
        </p>
      ) : null}
      {o.trackingUrl ? (
        <p>
          <a href={o.trackingUrl} rel="noreferrer noopener" target="_blank" className="underline">
            Seguir en el transportista
          </a>
        </p>
      ) : null}
    </>
  );
}
