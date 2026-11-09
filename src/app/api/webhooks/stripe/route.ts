import { after, NextResponse, type NextRequest } from 'next/server';
import { resolveCorrelationId } from '@/modules/platform/infrastructure/request-pipeline';
import { triggerJobRun } from '@/modules/jobs/infrastructure/job-trigger';
import { getServices } from '@/services/composition';

export const dynamic = 'force-dynamic';

/** Tamano maximo aceptado: los eventos de Stripe pesan unos pocos KB (NFR-U3-14). */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Webhook de la plataforma de Stripe (BR3-WH1): verifica la firma sobre el cuerpo crudo, guarda el
 * evento, encola el trabajo y responde. Sin limite de tasa (BR-L5): la firma protege.
 */
export async function POST(request: NextRequest) {
  const correlationId = resolveCorrelationId(request.headers.get('x-correlation-id'));
  const services = getServices();
  if (!services) {
    return NextResponse.json({ error: { code: 'dependency_unavailable' } }, { status: 503 });
  }

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { code: 'validation', correlationId } }, { status: 413 });
  }
  const signature = request.headers.get('stripe-signature') ?? '';
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { code: 'validation', correlationId } }, { status: 413 });
  }
  const result = await services.ingestPayment.handle(rawBody, signature, correlationId);

  if (result === 'invalid_signature') {
    return NextResponse.json({ error: { code: 'validation', correlationId } }, { status: 400 });
  }
  if (result === 'accepted') {
    // Disparo inmediato; si falla, pg_cron procesa la cola igualmente (P-RES-3).
    after(() => triggerJobRun(services.runtime.config, services.runtime.logger));
  }
  return NextResponse.json({ received: true }, { headers: { 'x-correlation-id': correlationId } });
}
