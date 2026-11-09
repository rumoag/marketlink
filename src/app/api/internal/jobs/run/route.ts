import { NextResponse, type NextRequest } from 'next/server';
import { appError } from '@/modules/kernel/domain/app-error';
import { resolveCorrelationId } from '@/modules/platform/infrastructure/request-pipeline';
import { secretMatches } from '@/modules/platform/infrastructure/secrets';
import { getServices } from '@/services/composition';

export const dynamic = 'force-dynamic';
// Margen sobre el presupuesto de 25 s del lote (el limite real depende del plan; se verifica).
export const maxDuration = 60;

/** Trabajos que en produccion programa pg_cron (migraciones de U3 y U4). */
const PERIODIC_JOBS = [
  'dispatch_notifications',
  'poll_shipments',
  'expire_stale_orders',
  'remind_pickup',
  'remind_pay_label',
  'retry_settlements',
  'withdraw_payout',
] as const;

/**
 * Procesa un lote de la cola. Lo llaman pg_cron y el disparo inmediato, siempre con el secreto
 * compartido; sin el devuelve 401 generico y deja un AuditEvent.
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
  const { runtime, jobs } = services;

  if (!secretMatches(request.headers.get('x-internal-secret'), runtime.config.internalJobsSecret)) {
    const r = await runtime.errors.handle(appError('unauthenticated'), {
      correlationId,
      resource: '/api/internal/jobs/run',
    });
    return NextResponse.json(r.body, { status: r.status, headers: r.headers });
  }

  try {
    // Sin pg_cron (E2E hermetico), cada llamada hace de «reloj»: encola los trabajos periodicos.
    if (services.e2e) {
      const tick = Date.now();
      for (const type of PERIODIC_JOBS) {
        await jobs.enqueue({ type, dedupeKey: `e2e-tick:${type}:${tick}` });
      }
    }
    const summary = await jobs.runBatch({ correlationId, limit: 25 });
    return NextResponse.json(summary, {
      headers: { 'Cache-Control': 'no-store', 'x-correlation-id': correlationId },
    });
  } catch (cause) {
    const r = await runtime.errors.handle(cause, { correlationId });
    return NextResponse.json(r.body, { status: r.status, headers: r.headers });
  }
}
