import { NextResponse, type NextRequest } from 'next/server';
import { resolveCorrelationId } from '@/modules/platform/infrastructure/request-pipeline';
import { getServices } from '@/services/composition';

export const dynamic = 'force-dynamic';

/** Borrador de factura en PDF, a demanda y solo para la artista del pedido (BR4-FC1, BR4-FC2). */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const artistId = request.headers.get('x-ml-artist-id');
  const services = getServices();
  const notFound = () => new NextResponse('No encontrado', { status: 404 });
  if (!artistId || !services) return notFound();

  const { id } = await ctx.params;
  const correlationId = resolveCorrelationId(request.headers.get('x-correlation-id'));
  const result = await services.invoice.execute(artistId, id, correlationId);
  if (!result.ok) return notFound();
  return new NextResponse(Buffer.from(result.value), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="borrador-factura.pdf"',
      'Cache-Control': 'private, no-store',
    },
  });
}
