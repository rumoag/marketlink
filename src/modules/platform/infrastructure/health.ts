import type { Db } from './db-client';

export type ShallowHealth = { readonly status: 'ok' };

export type DeepHealth = {
  readonly status: 'ok' | 'degraded';
  readonly checks: { readonly database: 'ok' | 'fail' };
  /** U3 (NFR-U3-31): avisos al operador de las ultimas 24 h; el monitor externo avisa si crece. */
  readonly operatorAlerts24h?: number;
};

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
  const status = database === 'ok' ? ('ok' as const) : ('degraded' as const);
  if (database !== 'ok') return { status, checks: { database } };
  try {
    const res = await withTimeout(
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events
          WHERE action = 'operator_alert' AND occurred_at > now() - interval '24 hours'`,
      ),
      3_000,
    );
    const n = Number(res.rows[0]?.n);
    return Number.isFinite(n)
      ? { status, checks: { database }, operatorAlerts24h: n }
      : { status, checks: { database } };
  } catch {
    return { status, checks: { database } };
  }
};
