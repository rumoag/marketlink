import { TERMS_VERSION } from '@/modules/checkout/domain/consent';
import { getAppName } from '@/modules/platform/infrastructure/runtime';
import { legalFacts } from '@/ui/legal';

export const metadata = { title: 'Condiciones de compra' };

/** Texto PROVISIONAL (BR3-CS3): pendiente de revision legal en U7 antes de vender a compradoras reales. */
export default function CondicionesPage() {
  const facts = legalFacts();
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 px-4 py-8">
      <p
        role="note"
        data-testid="legal-borrador"
        className="rounded-md border border-[color:var(--color-acento)] p-3 font-medium"
      >
        Borrador pendiente de revisión legal ({TERMS_VERSION}).
      </p>
      <h1 className="text-2xl font-semibold">Condiciones de compra</h1>
      <p>
        Compras una obra original a la persona que la vende a través de {getAppName()}. El precio
        incluye la obra y el envío indicado antes de pagar.
      </p>
      <h2 className="text-xl font-semibold">Entrega</h2>
      <p>Solo enviamos a la península. El plazo estimado se muestra al calcular el envío.</p>
      <h2 className="text-xl font-semibold">Desistimiento e incidencias</h2>
      <p>
        Si la obra llega dañada o no llega, escribe a{' '}
        <span data-testid="legal-contacto">{facts.contactEmail}</span>. Las condiciones de
        devolución se concretarán en la versión definitiva.
      </p>
    </main>
  );
}
