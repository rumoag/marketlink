import { NextResponse, type NextRequest } from 'next/server';
import { Email } from '@/modules/kernel/domain/formats';
import { secretMatches } from '@/modules/platform/infrastructure/secrets';
import { getServices } from '@/services/composition';

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });

/**
 * SOLO PRUEBAS (E2E_ENABLED, rechazado en live): emite un enlace de acceso valido sin enviar
 * correo. Exige ademas el secreto interno; en cualquier otro caso responde 404.
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
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; operator?: unknown };
  const email = Email.parse(typeof body.email === 'string' ? body.email : '');
  if (!email.ok) return NextResponse.json({ error: { code: 'validation' } }, { status: 400 });

  const tokenHash = services.e2e.auth.issueMagicLink(email.value);
  const path = body.operator === true ? '/operador/acceso/confirmar' : '/acceso/confirmar';
  const url = `${services.runtime.config.appUrl}${path}?token_hash=${encodeURIComponent(tokenHash)}`;
  return NextResponse.json({ url });
}
