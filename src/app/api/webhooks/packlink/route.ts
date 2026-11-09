import { after, NextResponse, type NextRequest } from 'next/server';
import { resolveCorrelationId } from '@/modules/platform/infrastructure/request-pipeline';
import { triggerJobRun } from '@/modules/jobs/infrastructure/job-trigger';
import { getServices } from '@/services/composition';

export const dynamic = 'force-dynamic';

/** Los eventos de Packlink pesan pocos KB (NFR-U4-13). */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Webhook de Packlink (BR4-EV1): comprueba el secreto en tiempo constante, guarda el hecho, encola
 * el trabajo y responde. Cualquier otra cosa se confirma sin efecto.
 */
export async function POST(request: NextRequest) {
  const correlationId = resolveCorrelationId(request.headers.get('x-correlation-id'));
  const services = getServices();
  if (!services) {
    return NextResponse.json({ error: { code: 'dependency_unavailable' } }, { status: 503 });
  }

  const declared = Number(request.headers.get('content-length') ?? 0);
  const rawBody = declared > MAX_BODY_BYTES ? '' : await request.text();
  if (declared > MAX_BODY_BYTES || rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { code: 'validation', correlationId } }, { status: 413 });
  }

  const result = await services.ingestShipment.handle(
    rawBody,
    request.headers.get('x-packlink-webhook-secret'),
    correlationId,
  );
  if (result === 'invalid_signature') {
    return NextResponse.json({ error: { code: 'validation', correlationId } }, { status: 400 });
  }
  if (result === 'accepted') {
    after(() => triggerJobRun(services.runtime.config, services.runtime.logger));
  }
  return NextResponse.json({ received: true }, { headers: { 'x-correlation-id': correlationId } });
}
