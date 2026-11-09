import { NextResponse, type NextRequest } from 'next/server';
import { appError } from '@/modules/kernel/domain/app-error';
import { MAX_UPLOAD_BYTES } from '@/modules/listings/domain/photo-rules';
import { resolveCorrelationId } from '@/modules/platform/infrastructure/request-pipeline';
import { getServices } from '@/services/composition';

export const dynamic = 'force-dynamic';
// Procesar una foto cabe de sobra en 30 s (objetivo: menos de 3 s por foto).
export const maxDuration = 30;

/**
 * Subida de UNA foto por peticion (P2-FOT-1). El navegador envia los bytes ya reducidos como cuerpo
 * crudo; el servidor valida por contenido y procesa siempre. El artista sale de la cabecera interna
 * que fija el proxy tras comprobar la sesion.
 */
export async function POST(request: NextRequest) {
  const correlationId = resolveCorrelationId(request.headers.get('x-correlation-id'));
  const services = getServices();
  if (!services) {
    return NextResponse.json(
      { error: { code: 'dependency_unavailable', correlationId } },
      { status: 503 },
    );
  }
  const artistId = request.headers.get('x-ml-artist-id');
  if (!artistId) {
    const r = await services.runtime.errors.handle(appError('unauthenticated'), { correlationId });
    return NextResponse.json(r.body, { status: r.status, headers: r.headers });
  }

  // Rechazo temprano por tamano declarado, antes de leer el cuerpo.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: { code: 'validation', message: 'La foto es demasiado grande.', correlationId } },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  const uploaded = await services.photos.upload(artistId, bytes, correlationId);
  if (!uploaded.ok) {
    const r = await services.runtime.errors.handle(uploaded.error, { correlationId });
    return NextResponse.json(r.body, { status: r.status, headers: r.headers });
  }
  return NextResponse.json(uploaded.value, {
    headers: { 'Cache-Control': 'no-store', 'x-correlation-id': correlationId },
  });
}
