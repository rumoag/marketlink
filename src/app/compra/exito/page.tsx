import type { Metadata } from 'next';
import Link from 'next/link';
import { requestInfo, requireServices } from '@/ui/server-context';
import { CopiarEnlace } from './copiar-enlace';
import { Refrescar } from './refrescar';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * Pagina de exito (BR3-EX*): el pedido se localiza por el identificador de la sesion de pago. No
 * marca nada como pagado: el estado lo decide el webhook (o el respaldo por reloj).
 */
export default async function ExitoPage({
  searchParams,
}: {
  searchParams: Promise<{ sesion?: string }>;
}) {
  const { sesion } = await searchParams;
  const { correlationId, ip } = await requestInfo();
  const services = requireServices();
  const result = await services.success.execute(sesion ?? '', ip, correlationId);

  if (!result.ok) {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold">No encontramos ese pedido</h1>
        <p data-testid="exito-desconocido">
          Si acabas de pagar, espera unos minutos y recibirás la confirmación.
        </p>
      </Shell>
    );
  }

  const order = result.value;
  const trackingPath = order.trackingToken ? `/seguimiento/${order.trackingToken}` : undefined;

  // Pagado o ya en la cadena de envio (U4): la compradora puede volver a esta pagina mas tarde.
  const paidChain = [
    'pagado',
    'error_borrador',
    'borrador_creado',
    'etiqueta_lista',
    'en_transito',
    'entregado',
    'liquidado',
  ].includes(order.status);
  if (paidChain) {
    return (
      <Shell>
        <h1 data-testid="exito-titulo" className="text-2xl font-semibold">
          {order.status === 'en_transito'
            ? 'Tu pedido está en camino'
            : order.status === 'entregado' || order.status === 'liquidado'
              ? 'Tu pedido ha sido entregado'
              : 'Pago recibido. Te avisaremos cuando salga el envío.'}
        </h1>
        <p>{order.title}</p>
        {trackingPath ? (
          <CopiarEnlace path={trackingPath} />
        ) : (
          <p>Guarda esta página para consultar tu pedido.</p>
        )}
      </Shell>
    );
  }

  if (order.status === 'pendiente_pago') {
    return (
      <Shell>
        <Refrescar />
        <h1 data-testid="exito-confirmando" className="text-2xl font-semibold">
          Estamos confirmando tu pago…
        </h1>
        <p>
          Si has pagado, recibirás la confirmación en breve. Guarda esta página o{' '}
          <Link
            href={`/compra/exito?sesion=${encodeURIComponent(sesion ?? '')}`}
            className="underline"
          >
            actualízala
          </Link>
          .
        </p>
      </Shell>
    );
  }

  if (order.status === 'incidencia' || order.status === 'reembolsado') {
    return (
      <Shell>
        <h1 data-testid="exito-reembolso" className="text-2xl font-semibold">
          Tu pago se reembolsará
        </h1>
        <p>La obra ya no está disponible. {order.statusText}.</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 data-testid="exito-no-completado" className="text-2xl font-semibold">
        El pago no se ha completado
      </h1>
      <p>No se ha cobrado nada. Puedes volver a la obra e intentarlo de nuevo.</p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-8">{children}</main>
  );
}
