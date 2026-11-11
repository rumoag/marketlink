import type { Metadata } from 'next';
import { Money } from '@/modules/kernel/domain/money';
import { formatMadrid } from '@/modules/kernel/domain/dates';
import { instantOf } from '@/modules/kernel/domain/clock';
import { deliveryText } from '@/ui/delivery-text';
import { requestInfo, requireServices } from '@/ui/server-context';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const euros = (cents: number): string => Money.format({ cents, currency: 'EUR' });

/**
 * Seguimiento por token (BR3-SG*). Cualquier fallo (token mal formado, desconocido o limite de uso)
 * muestra la misma respuesta generica. No lleva nombre, correo, telefono ni direccion.
 */
export default async function SeguimientoPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { correlationId, ip } = await requestInfo();
  const result = await requireServices().trackingDetails.execute(token, ip, correlationId);

  if (!result.ok) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-8">
        <h1 data-testid="seguimiento-desconocido" className="text-2xl font-semibold">
          No encontramos ese pedido
        </h1>
        <p>Comprueba el enlace que guardaste.</p>
      </main>
    );
  }

  const v = result.value;
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-8">
      <h1 data-testid="seguimiento-estado" className="text-2xl font-semibold">
        {v.statusText}
      </h1>
      <p data-testid="seguimiento-obra">
        {v.title} · de {v.artisticName}
      </p>
      <section aria-label="Cómo recibirás la obra" className="flex flex-col gap-1">
        <p data-testid="seguimiento-servicio">{deliveryText(v.delivery)}</p>
        {v.delivery.point ? (
          <p data-testid="seguimiento-punto">
            Punto de recogida: <strong>{v.delivery.point.name}</strong>, {v.delivery.point.address}
            {v.delivery.point.schedule ? ` (${v.delivery.point.schedule})` : ''}
          </p>
        ) : null}
      </section>
      <section aria-label="Importes" className="flex flex-col gap-1">
        <p className="flex justify-between">
          <span>Obra</span>
          <span>{euros(v.workPriceCents)}</span>
        </p>
        <p className="flex justify-between">
          <span>Envío</span>
          <span>{euros(v.shippingCents)}</span>
        </p>
        <p className="flex justify-between text-lg font-semibold">
          <span>Total</span>
          <span data-testid="seguimiento-total">{euros(v.totalCents)}</span>
        </p>
      </section>
      <p className="text-sm text-[color:var(--color-texto-suave)]">
        Pedido del {formatMadrid(instantOf(v.createdAtMs))}
      </p>
      {v.history.length > 0 ? (
        <section aria-label="Historial" className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Historial</h2>
          <ol data-testid="seguimiento-historial" className="flex flex-col gap-1">
            {v.history.map((h) => (
              <li key={`${h.label}-${h.atMs}`}>
                {h.label} · {formatMadrid(instantOf(h.atMs))}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {v.carrierUrl ? (
        <p>
          <a
            href={v.carrierUrl}
            rel="noreferrer noopener"
            target="_blank"
            data-testid="seguimiento-transportista"
            className="underline"
          >
            Seguir en el transportista
          </a>
        </p>
      ) : null}
      {v.manual ? (
        <section
          aria-label="Instrucciones de pago por Bizum"
          data-testid="seguimiento-bizum"
          className="flex flex-col gap-1 rounded-md border border-[color:var(--color-acento)] p-4"
        >
          <p className="font-semibold">Paga por Bizum al artista</p>
          <p>
            Envía <strong>{euros(v.manual.amountCents)}</strong> por Bizum al{' '}
            <strong data-testid="seguimiento-bizum-telefono">{v.manual.bizumPhone}</strong>. El
            artista confirmará el cobro y te avisaremos.
          </p>
        </section>
      ) : null}
    </main>
  );
}
