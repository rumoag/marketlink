import { notFound } from 'next/navigation';
import { requireServices } from '@/ui/server-context';
import { advanceShipmentAction } from './actions';

export const dynamic = 'force-dynamic';

const STEPS = [
  ['etiqueta', 'Etiqueta lista'],
  ['transito', 'En tránsito'],
  ['entregado', 'Entregado'],
  ['fallo_etiqueta', 'Fallo de etiqueta'],
  ['fallo_transportista', 'Fallo del transportista'],
] as const;

/** «Panel de Packlink» simulado para E2E. Solo existe con E2E_ENABLED (404 en caso contrario). */
export default async function EnvioSimuladoPage({ params }: { params: Promise<{ ref: string }> }) {
  const services = requireServices();
  if (!services.e2e) notFound();
  const { ref } = await params;
  const shipment = services.e2e.shipments.get(ref);
  if (!shipment) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 px-4 py-8">
      <h1 className="text-xl font-semibold">Envío simulado {ref}</h1>
      <p data-testid="e2e-envio-estado">Estado: {shipment.state}</p>
      <form action={advanceShipmentAction} className="flex flex-wrap gap-3">
        <input type="hidden" name="ref" value={ref} />
        {STEPS.map(([value, label]) => (
          <button
            key={value}
            name="state"
            value={value}
            data-testid={`e2e-envio-${value}`}
            className="min-h-11 rounded-md border px-4"
          >
            {label}
          </button>
        ))}
      </form>
    </main>
  );
}
