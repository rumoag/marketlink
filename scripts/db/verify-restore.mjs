// Comprueba la integridad de una base restaurada desde una copia (U7, BR7-CP2).
//
// Uso:
//   VERIFY_DATABASE_URL=postgres://... node scripts/db/verify-restore.mjs [--allow-empty]
//
// Comprobaciones:
//  1. Existen las tablas esperadas.
//  2. Hay filas en las tablas que no deberian estar vacias (salvo con --allow-empty: copia de una
//     base recien creada).
//  3. El libro de dinero conserva el dinero por pedido (lo cobrado en `stripe` es igual a lo
//     repartido en el resto de cubos).
//  4. El saldo guardado de cada artista coincide con el derivado del libro.
//  5. No hay pedidos sin artista.
// Sale con codigo 1 y una lista clara de problemas si algo no cuadra. No escribe nada.
import pg from 'pg';

const url = process.env.VERIFY_DATABASE_URL;
if (!url) {
  process.stderr.write('Falta VERIFY_DATABASE_URL\n');
  process.exit(2);
}
const allowEmpty = process.argv.includes('--allow-empty');

const EXPECTED_TABLES = [
  'artists',
  'listings',
  'orders',
  'order_events',
  'shipments',
  'notifications',
  'ledger_entries',
  'artist_balances',
  'settlements',
  'withdrawals',
  'refunds',
  'audit_events',
  'jobs',
  'order_flags',
  'operator_notes',
  'listing_views',
  'backup_runs',
];
const NOT_EMPTY = ['artists', 'orders'];

const client = new pg.Client({ connectionString: url });
await client.connect();
const problems = [];
try {
  const tables = new Set(
    (
      await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      )
    ).rows.map((r) => r.table_name),
  );
  for (const t of EXPECTED_TABLES) if (!tables.has(t)) problems.push(`falta la tabla ${t}`);

  if (problems.length === 0) {
    if (!allowEmpty) {
      for (const t of NOT_EMPTY) {
        const n = Number((await client.query(`SELECT count(*) AS n FROM public.${t}`)).rows[0].n);
        if (n === 0) problems.push(`la tabla ${t} está vacía`);
      }
    }

    const gaps = await client.query(`
      SELECT order_id,
             COALESCE(SUM(delta_cents) FILTER (WHERE bucket = 'stripe'), 0)
             - COALESCE(SUM(delta_cents) FILTER (WHERE bucket <> 'stripe'), 0) AS gap
        FROM public.ledger_entries WHERE order_id IS NOT NULL
       GROUP BY order_id
      HAVING COALESCE(SUM(delta_cents) FILTER (WHERE bucket = 'stripe'), 0)
             <> COALESCE(SUM(delta_cents) FILTER (WHERE bucket <> 'stripe'), 0)
       LIMIT 20`);
    for (const g of gaps.rows)
      problems.push(`el libro no conserva el dinero del pedido ${g.order_id} (${g.gap})`);

    const balances = await client.query(`
      WITH derived AS (
        SELECT artist_id,
               COALESCE(SUM(delta_cents) FILTER (WHERE bucket = 'retenido'), 0) AS retained,
               COALESCE(SUM(delta_cents) FILTER (WHERE bucket = 'disponible'), 0) AS available
          FROM public.ledger_entries WHERE artist_id IS NOT NULL GROUP BY artist_id)
      SELECT COALESCE(d.artist_id, b.artist_id) AS artist_id
        FROM derived d FULL OUTER JOIN public.artist_balances b ON b.artist_id = d.artist_id
       WHERE COALESCE(d.retained, 0) <> COALESCE(b.retained_cents, 0)
          OR COALESCE(d.available, 0) <> COALESCE(b.available_cents, 0)
       LIMIT 20`);
    for (const b of balances.rows)
      problems.push(`el saldo de la artista ${b.artist_id} no coincide con el libro`);

    const orphans = Number(
      (
        await client.query(
          'SELECT count(*) AS n FROM public.orders o LEFT JOIN public.artists a ON a.id = o.artist_id WHERE a.id IS NULL',
        )
      ).rows[0].n,
    );
    if (orphans > 0) problems.push(`${orphans} pedidos sin artista`);
  }
} finally {
  await client.end();
}

if (problems.length > 0) {
  process.stderr.write('RESTAURACIÓN CON PROBLEMAS:\n');
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}
process.stdout.write('Restauración correcta: tablas, libro, saldos y pedidos coherentes.\n');
