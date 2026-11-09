import { notFound } from 'next/navigation';
import { Money } from '@/modules/kernel/domain/money';
import { requireServices } from '@/ui/server-context';
import { AccionesPagoSimulado } from './acciones';

export const dynamic = 'force-dynamic';

/**
 * «Pagina de Stripe» simulada para E2E. Solo existe con E2E_ENABLED (que la configuracion rechaza
 * en live); en cualquier otro caso responde 404 como si no existiera.
 */
export default async function PagoSimuladoPage({
  params,
}: {
  params: Promise<{ session: string }>;
}) {
  const services = requireServices();
  if (!services.e2e) notFound();
  const { session } = await params;
  const found = services.e2e.payment.get(session);
  if (!found) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 px-4 py-8">
      <h1 data-testid="e2e-pago-titulo" className="text-xl font-semibold">
        Pago simulado
      </h1>
      <p data-testid="e2e-pago-importe">
        Importe: {Money.format({ cents: found.amountCents, currency: 'EUR' })}
      </p>
      <AccionesPagoSimulado session={session} />
    </main>
  );
}
