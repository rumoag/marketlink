import { NextResponse, type NextRequest } from 'next/server';
import { RESUME_COOKIE_NAME } from '@/modules/checkout/domain/consent';
import { resolveCorrelationId } from '@/modules/platform/infrastructure/request-pipeline';
import { getServices } from '@/services/composition';

export const dynamic = 'force-dynamic';

/**
 * Vuelta desde Stripe sin pagar (BR3-RT1, riesgo R-09 aceptado): cancela el pedido pendiente que
 * identifica la cookie de reintento, libera la reserva y devuelve a la obra con el formulario
 * rellenado. Es idempotente y solo afecta al pedido de quien presenta la cookie secreta.
 */
export async function GET(request: NextRequest) {
  const correlationId = resolveCorrelationId(request.headers.get('x-correlation-id'));
  const services = getServices();
  // Redireccion relativa: conserva el host con el que llego el navegador (la cookie de reintento
  // no viaja entre `localhost` y `127.0.0.1`, que es lo que `request.nextUrl` puede devolver).
  const go = (path: string) =>
    new NextResponse(null, {
      status: 307,
      headers: { location: path, 'cache-control': 'no-store' },
    });
  if (!services) return go('/');

  const resumeId = request.cookies.get(RESUME_COOKIE_NAME)?.value;
  const outcome = await services.cancelCheckout.execute(resumeId, correlationId);

  if (outcome.kind === 'paid') {
    return go(
      outcome.sessionId ? `/compra/exito?sesion=${encodeURIComponent(outcome.sessionId)}` : '/',
    );
  }
  if (outcome.kind === 'cancelled' && outcome.form) {
    return go(`/${outcome.form.slug}`);
  }
  return go('/');
}
