import type { Db } from './db-client';

export type ShallowHealth = { readonly status: 'ok' };

export type DeepHealth = {
  readonly status: 'ok' | 'degraded';
  readonly checks: { readonly database: 'ok' | 'fail' };
  /** U3 (NFR-U3-31): avisos al operador de las ultimas 24 h; el monitor externo avisa si crece. */
  readonly operatorAlerts24h?: number;
  /** Segundos que lleva esperando el trabajo listo mas antiguo; ausente si la cola esta al dia. */
  readonly jobsOldestPendingSeconds?: number;
};

/** Un trabajo listo que espera mas de esto (5 minutos) pone la salud profunda en degradado. */
export const JOBS_BACKLOG_SECONDS = 300;

/** Salud superficial: sin dependencias, apta para monitorizacion sintetica publica (P-OBS-2). */
export const shallowHealth = (): ShallowHealth => ({ status: 'ok' });

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

/** Salud profunda: comprueba la base de datos. Los proveedores se anaden en U7. */
export const deepHealth = async (
  db: Pick<Db, 'query'>,
  /** Recibe la causa de un fallo de la base de datos, para dejarla en los registros. */
  onDatabaseError?: (cause: unknown) => void,
): Promise<DeepHealth> => {
  let database: 'ok' | 'fail' = 'ok';
  try {
    await withTimeout(db.query('SELECT 1'), 3_000);
  } catch (cause) {
    database = 'fail';
    onDatabaseError?.(cause);
  }
  if (database !== 'ok') return { status: 'degraded' as const, checks: { database } };

  let operatorAlerts24h: number | undefined;
  try {
    const res = await withTimeout(
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events
          WHERE action = 'operator_alert' AND occurred_at > now() - interval '24 hours'`,
      ),
      3_000,
    );
    const n = Number(res.rows[0]?.n);
    if (Number.isFinite(n)) operatorAlerts24h = n;
  } catch {
    // sin el dato, la salud profunda sigue valiendo
  }

  // Un trabajo ya listo que espera mucho significa que el reloj o la cola no corren: los pagos y
  // los envios no avanzarian (ADR 0030). El monitor externo avisa porque el estado pasa a degradado.
  let oldestSeconds: number | undefined;
  try {
    const res = await withTimeout(
      db.query<{ s: string | null }>(
        `SELECT extract(epoch FROM (now() - min(run_at)))::bigint::text AS s
           FROM jobs WHERE status = 'pending' AND run_at <= now()`,
      ),
      3_000,
    );
    const v = res.rows[0]?.s;
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) {
      oldestSeconds = Math.max(0, Number(v));
    }
  } catch {
    // idem
  }
  const backlogged = oldestSeconds !== undefined && oldestSeconds > JOBS_BACKLOG_SECONDS;
  return {
    status: backlogged ? ('degraded' as const) : ('ok' as const),
    checks: { database },
    ...(operatorAlerts24h !== undefined ? { operatorAlerts24h } : {}),
    ...(oldestSeconds !== undefined ? { jobsOldestPendingSeconds: oldestSeconds } : {}),
  };
};
