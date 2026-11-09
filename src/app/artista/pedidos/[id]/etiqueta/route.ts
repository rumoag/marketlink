import { NextResponse, type NextRequest } from 'next/server';
import { resolveCorrelationId } from '@/modules/platform/infrastructure/request-pipeline';
import { getServices } from '@/services/composition';

export const dynamic = 'force-dynamic';

/**
 * Descarga de la etiqueta (BR4-LB2): sesion de artista → comprobacion de propiedad del pedido →
 * redireccion a una URL firmada de 5 minutos (el PDF no pasa por la funcion). Pedido ajeno e
 * inexistente dan la misma respuesta.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const artistId = request.headers.get('x-ml-artist-id');
  const services = getServices();
  const notFound = () => new NextResponse('No encontrado', { status: 404 });
  if (!artistId || !services) return notFound();

  const { id } = await ctx.params;
  const correlationId = resolveCorrelationId(request.headers.get('x-correlation-id'));
  const result = await services.labelDownload.execute(artistId, id, correlationId);
  if (!result.ok) return notFound();
  return NextResponse.redirect(result.value.url, 302);
}
