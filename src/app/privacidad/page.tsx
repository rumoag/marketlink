import { PRIVACY_VERSION } from '@/modules/checkout/domain/consent';
import { getAppName } from '@/modules/platform/infrastructure/runtime';
import { legalFacts } from '@/ui/legal';

export const metadata = { title: 'Aviso de privacidad' };

/** Texto PROVISIONAL: pendiente de revisión del asesor antes de vender a compradoras reales (EN-16). */
export default function PrivacidadPage() {
  const facts = legalFacts();
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 px-4 py-8">
      <p
        role="note"
        data-testid="legal-borrador"
        className="rounded-md border border-[color:var(--color-acento)] p-3 font-medium"
      >
        Borrador pendiente de revisión legal ({PRIVACY_VERSION}).
      </p>
      <h1 className="text-2xl font-semibold">Aviso de privacidad</h1>
      <p>
        {getAppName()} trata tus datos (nombre, correo, teléfono y dirección de entrega) solo para
        gestionar tu compra y el envío de la obra.
      </p>
      <h2 className="text-xl font-semibold">Con quién los compartimos</h2>
      <p>
        Con la persona que vende la obra (nombre y localidad), con el transportista (los datos
        necesarios para entregar el paquete) y con el proveedor de pagos (Stripe).
      </p>
      <h2 className="text-xl font-semibold">Cuánto tiempo los conservamos</h2>
      <p data-testid="legal-plazos">
        {facts.unpaid} {facts.retention} {facts.financial}
      </p>
      <h2 className="text-xl font-semibold">Tus derechos</h2>
      <p data-testid="legal-derechos">{facts.rights}</p>
    </main>
  );
}
