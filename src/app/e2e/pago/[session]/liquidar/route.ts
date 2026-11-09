import { notFound } from 'next/navigation';
import { NextResponse, type NextRequest } from 'next/server';
import { factFromEvent } from '@/modules/orders/application/process-payment-event';
import { resolveCorrelationId } from '@/modules/platform/infrastructure/request-pipeline';
import { getServices } from '@/services/composition';

export const dynamic = 'force-dynamic';

/**
 * Simula lo que hace Stripe al terminar el pago: marca la sesion, entrega al sistema el mismo
 * hecho que traeria el webhook (se procesa en linea para que el E2E no dependa de la cola) y
 * devuelve la URL de exito o de cancelacion a la que navega el cliente. Solo existe con E2E_ENABLED (la configuracion lo rechaza en live).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ session: string }> }) {
  const services = getServices();
  if (!services?.e2e) notFound();
  const { session: sessionId } = await ctx.params;
  const form = await request.formData();
  const outcome = String(form.get('outcome') ?? '');
  if (outcome !== 'pagar' && outcome !== 'cancelar' && outcome !== 'caducar') notFound();

  const correlationId = resolveCorrelationId(request.headers.get('x-correlation-id'));
  const fake = services.e2e.payment;
  const session = fake.settle(sessionId, outcome);
  if (!session) notFound();

  if (outcome === 'pagar') {
    const fact = factFromEvent(fake.eventFor(session, 'completed'));
    if (fact) await services.processPayment.execute(fact, correlationId);
    return NextResponse.json({ redirect: session.successUrl });
  }
  if (outcome === 'caducar') {
    const fact = factFromEvent(fake.eventFor(session, 'expired'));
    if (fact) await services.processPayment.execute(fact, correlationId);
  }
  return NextResponse.json({ redirect: session.cancelUrl });
}
