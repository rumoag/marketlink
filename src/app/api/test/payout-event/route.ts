import { NextResponse, type NextRequest } from 'next/server';
import { secretMatches } from '@/modules/platform/infrastructure/secrets';
import { resolveCorrelationId } from '@/modules/platform/infrastructure/request-pipeline';
import { getServices } from '@/services/composition';

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });

/**
 * SOLO PRUEBAS (E2E_ENABLED, rechazado en live): simula un cambio de estado de la cuenta de cobros
 * de un artista (habilitada o deshabilitada) y lo aplica con el caso de uso real.
 */
export async function POST(request: NextRequest) {
  const services = getServices();
  if (!services?.e2e) return notFound();
  if (
    !secretMatches(
      request.headers.get('x-internal-secret'),
      services.runtime.config.internalJobsSecret,
    )
  ) {
    return notFound();
  }
  const body = (await request.json().catch(() => ({}))) as {
    email?: unknown;
    disabled?: unknown;
  };
  const artistId =
    typeof body.email === 'string' ? services.e2e.auth.userIdForEmail(body.email) : undefined;
  if (!artistId) {
    return NextResponse.json({ error: { code: 'validation' } }, { status: 400 });
  }
  const correlationId = resolveCorrelationId(request.headers.get('x-correlation-id'));
  const disabled = body.disabled === true;
  const applied = await services.apply.applySnapshot(
    artistId,
    {
      detailsSubmitted: true,
      transfersActive: !disabled,
      payoutsEnabled: !disabled,
      disabled,
      eventAt: Date.now(),
    },
    correlationId,
  );
  return applied.ok
    ? NextResponse.json(applied.value)
    : NextResponse.json({ error: { code: applied.error.code } }, { status: 409 });
}
