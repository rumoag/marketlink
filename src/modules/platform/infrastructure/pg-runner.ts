import type { QueryResult, QueryResultRow } from 'pg';
import type { Scope, TransactionRunner } from '../application/unit-of-work';
import type { Db } from './db-client';

/** Lo minimo que necesitan los repositorios: ejecutar consultas dentro de la transaccion. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Ejecuta cada operacion en una transaccion y fija el contexto que leen las politicas RLS
 * (`app.artist_id` o `app.system`). Los ajustes son locales a la transaccion, por lo que son
 * seguros con el agrupador de conexiones en modo transaccion. Sin contexto no se ve ninguna fila.
 */
export class PgTransactionRunner<R> implements TransactionRunner<R> {
  constructor(
    private readonly db: Pick<Db, 'transaction'>,
    private readonly makeRepos: (q: Queryable) => R,
  ) {}

  run<T>(scope: Scope, fn: (repos: R) => Promise<T>): Promise<T> {
    return this.db.transaction(async (client) => {
      if (scope.kind === 'system') {
        await client.query(`SELECT set_config('app.system', 'on', true)`);
      } else {
        await client.query(
          `SELECT set_config('app.system', '', true), set_config('app.artist_id', $1, true)`,
          [scope.artistId],
        );
      }
      return fn(this.makeRepos(client));
    });
  }
}
