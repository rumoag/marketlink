import { NextResponse, type NextRequest } from 'next/server';
import { getServices } from '@/services/composition';

export const dynamic = 'force-dynamic';

/** «URL firmada» simulada de la etiqueta. Solo existe con E2E_ENABLED; si no, 404. */
export function GET(request: NextRequest) {
  const services = getServices();
  const key = request.nextUrl.searchParams.get('key');
  const bytes = services?.e2e && key ? services.e2e.labels.bytes(key) : undefined;
  if (!bytes) return new NextResponse('No encontrado', { status: 404 });
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store' },
  });
}
