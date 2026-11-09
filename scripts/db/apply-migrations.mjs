// Aplica las migraciones de supabase/migrations a un Postgres corriente (CI y desarrollo local).
// En Supabase real se usa `supabase db push` (workflow migrate.yml).
//
// Variables:
//   ADMIN_DATABASE_URL  conexion con un rol que pueda crear roles y tablas (obligatoria)
//   APP_ROLE_PASSWORD   si se define, habilita el LOGIN del rol marketlink_app con esa contrasena
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');
const url = process.env.ADMIN_DATABASE_URL;
if (!url) {
  process.stderr.write('Falta ADMIN_DATABASE_URL\n');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await client.query(readFileSync(path.join(dir, file), 'utf8'));
    process.stdout.write(`aplicada ${file}\n`);
  }
  const password = process.env.APP_ROLE_PASSWORD;
  if (password) {
    // El nombre del rol es fijo; la contrasena se pasa como literal escapado por el driver.
    const literal = client.escapeLiteral(password);
    await client.query(`ALTER ROLE marketlink_app LOGIN PASSWORD ${literal}`);
    process.stdout.write('rol marketlink_app habilitado\n');
  }
} finally {
  await client.end();
}
