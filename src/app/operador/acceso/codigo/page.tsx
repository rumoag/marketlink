import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { OPERATOR_COOKIE } from '@/modules/operator/domain/operator-session';
import { requireServices } from '@/ui/server-context';
import { OperatorCodeForm } from '../forms';

export const dynamic = 'force-dynamic';

export default async function OperadorCodigoPage() {
  const operator = requireServices().operator;
  if (!operator) notFound();
  // Solo con una sesion pendiente (enlace confirmado); si no, vuelve a pedir el enlace.
  const raw = (await cookies()).get(OPERATOR_COOKIE)?.value;
  if (!operator.sessions.pending(raw ? `${OPERATOR_COOKIE}=${raw}` : null)) {
    redirect('/operador/acceso');
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-12">
      <h1 data-testid="operador-codigo-title" className="text-2xl font-semibold">
        Segundo factor
      </h1>
      <OperatorCodeForm />
    </main>
  );
}
