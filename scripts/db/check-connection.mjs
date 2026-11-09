// Comprueba la conexion a la base con la MISMA configuracion que usa la aplicacion y explica el
// fallo mas probable. Todo ocurre en tu equipo: la cadena nunca se imprime ni se envia a ningun sitio.
//
// Uso (PowerShell):  $env:DATABASE_URL = "postgresql://..."; node scripts/db/check-connection.mjs
// Uso (bash):        DATABASE_URL="postgresql://..." node scripts/db/check-connection.mjs
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('Falta DATABASE_URL en el entorno.\n');
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  process.stderr.write(
    'La cadena no es una URL valida. Si la contrasena tiene @ # / : ? o %, hay que codificarlos en porcentaje.\n',
  );
  process.exit(1);
}
const user = decodeURIComponent(parsed.username);
const info = `usuario=${user} servidor=${parsed.hostname} puerto=${parsed.port || '5432'} base=${parsed.pathname.slice(1)}`;
process.stdout.write(`Probando: ${info}\n`);

const hints = [];
if (!user.includes('.')) {
  hints.push(
    'El usuario no lleva el id del proyecto. En los agrupadores de Supabase debe ser marketlink_app.<id-del-proyecto>.',
  );
}
if (!user.startsWith('marketlink_app')) {
  hints.push('La aplicacion debe conectarse con el rol marketlink_app, no con postgres.');
}
if (parsed.port === '5432' && parsed.hostname.includes('pooler')) {
  hints.push('Es el Session pooler (5432). Para Vercel usa el Transaction pooler (6543).');
}

const pool = new pg.Pool({
  connectionString: url,
  max: 1,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 8_000,
  query_timeout: 10_000,
});
try {
  const who = await pool.query('SELECT current_user AS usuario');
  process.stdout.write(`Conexion correcta como ${who.rows[0].usuario}.\n`);
  const tables = await pool.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
  );
  process.stdout.write(`Tablas visibles en public: ${tables.rows[0].n}\n`);
  await pool.query('SELECT 1 FROM audit_events LIMIT 1');
  process.stdout.write('audit_events accesible: la base y los permisos estan bien.\n');
} catch (e) {
  process.stdout.write(`FALLO: ${e.code ?? ''} ${String(e.message).slice(0, 200)}\n`);
  if (/password authentication failed/i.test(e.message)) {
    hints.push(
      'Contrasena rechazada. Comprueba que ejecutaste ALTER ROLE marketlink_app LOGIN PASSWORD ... y que la cadena lleva esa contrasena (codificada si tiene simbolos).',
    );
  }
  if (/Tenant or user not found/i.test(e.message)) {
    hints.push(
      'El usuario o el id del proyecto no son correctos (marketlink_app.<id-del-proyecto>).',
    );
  }
  if (/permission denied/i.test(e.message)) {
    hints.push('El rol conecta pero le faltan permisos: revisa que las migraciones se aplicaron.');
  }
  if (/timeout|ENOTFOUND|ECONNREFUSED/i.test(e.message)) {
    hints.push('No llega al servidor: revisa el host y el puerto de la cadena.');
  }
  for (const h of hints) process.stdout.write(`- ${h}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
