import { NextResponse, type NextRequest } from 'next/server';
import { appError } from '@/modules/kernel/domain/app-error';
import { deepHealth } from '@/modules/platform/infrastructure/health';
import { getRuntime } from '@/modules/platform/infrastructure/runtime';
import { secretMatches } from '@/modules/platform/infrastructure/secrets';
import { resolveCorrelationId } from '@/modules/platform/infrastructure/request-pipeline';

export const dynamic = 'force-dynamic';

/**
 * Salud profunda: solo con el secreto de monitorizacion (la sesion de operador se anade en U6).
 * Sin credenciales valida devuelve 401 generico y deja un AuditEvent.
 */
export async function GET(request: NextRequest) {
  const correlationId = resolveCorrelationId(request.headers.get('x-correlation-id'));
  const runtime = getRuntime();
  if (!runtime) {
    return NextResponse.json(
      { error: { code: 'dependency_unavailable', correlationId } },
      { status: 503 },
    );
  }
  const supplied = request.headers.get('x-monitor-secret');
  if (!secretMatches(supplied, runtime.config.monitorSecret)) {
    const r = await runtime.errors.handle(appError('unauthenticated'), {
      correlationId,
      resource: '/api/health/deep',
    });
    return NextResponse.json(r.body, { status: r.status, headers: r.headers });
  }
  const result = await deepHealth(runtime.db, (cause) => {
    // Solo el codigo y el mensaje del error (nunca la cadena de conexion).
    const e = cause as { code?: unknown; message?: unknown };
    runtime.logger.warn('health_deep_database_failed', {
      code: typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message.slice(0, 200) : undefined,
      correlationId,
    });
  });
  return NextResponse.json(result, {
    status: result.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store', 'x-correlation-id': correlationId },
  });
}
