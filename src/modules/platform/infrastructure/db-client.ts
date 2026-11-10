import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { AppConfig } from '../application/config';

/**
 * Acceso a Postgres a traves del agrupador de conexiones de Supabase (modo transaccion).
 * Sin sentencias preparadas con nombre (no las admite el modo transaccion) y con tiempos
 * de espera cortos para no agotar funciones serverless.
 */
export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
  /** Ejecuta `fn` dentro de una transaccion; hace rollback si lanza. */
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

const globalForDb = globalThis as unknown as { __marketlinkPool?: Pool };

/** Servidores locales o de contenedor (CI, desarrollo): sin TLS. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'db']);

/**
 * TLS hacia la base de datos. Supabase lo exige (ESSLREQUIRED). Con el certificado de la CA de
 * Supabase (`DATABASE_CA_CERT`) se verifica la identidad del servidor; sin el, la conexion va
 * cifrada pero sin verificar al servidor, lo que solo se acepta en sandbox (en live la
 * configuracion exige el certificado).
 */
export const sslFor = (
  connectionString: string,
  ca?: string,
): false | { rejectUnauthorized: boolean; ca?: string } => {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return false;
  }
  if (LOCAL_HOSTS.has(host)) return false;
  return ca !== undefined ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
};

export const createDb = (
  connectionString: string,
  options: { max?: number; ca?: string } = {},
): Db => {
  const pool = new Pool({
    connectionString,
    ssl: sslFor(connectionString, options.ca),
    max: options.max ?? 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 8_000,
    query_timeout: 10_000,
  });
  // Un error en un cliente inactivo no debe tumbar el proceso.
  pool.on('error', () => undefined);
  return wrapPool(pool);
};

const wrapPool = (pool: Pool): Db => ({
  query: <R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) =>
    pool.query<R>(text, params === undefined ? undefined : [...params]),
  transaction: async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  },
  end: () => pool.end(),
});

/** Singleton por proceso (sobrevive a recargas en desarrollo). */
export const getDb = (config: AppConfig): Db => {
  if (!globalForDb.__marketlinkPool) {
    const connectionString = config.databaseUrl.reveal();
    globalForDb.__marketlinkPool = new Pool({
      connectionString,
      ssl: sslFor(connectionString, config.databaseCaCert),
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 8_000,
      query_timeout: 10_000,
    });
    globalForDb.__marketlinkPool.on('error', () => undefined);
  }
  return wrapPool(globalForDb.__marketlinkPool);
};
