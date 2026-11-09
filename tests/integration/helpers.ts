import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe } from 'vitest';
import { createDb, type Db } from '@/modules/platform/infrastructure/db-client';

/**
 * Las pruebas de integracion usan un Postgres real (Docker local o contenedor de CI) en
 * TEST_DATABASE_URL. Sin esa variable se omiten (no hay Docker en todos los equipos).
 */
export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
export const describeDb = testDatabaseUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../supabase/migrations');

/** Salvaguarda: estas pruebas borran el esquema `public`; nunca contra una base real. */
export const assertSafeTestDatabase = (url: string): void => {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'db'].includes(u.hostname);
  const looksLikeTest = /test/i.test(u.pathname);
  if (!local && !looksLikeTest) {
    throw new Error('TEST_DATABASE_URL no parece una base de pruebas: se rechaza por seguridad');
  }
};

export const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

export const applyMigrations = async (db: Db): Promise<void> => {
  for (const file of migrationFiles()) {
    await db.query(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
};

/**
 * Reproduce los valores por defecto de Supabase: los roles de la API publica existen, usan el
 * esquema `public` y reciben todos los privilegios sobre las tablas nuevas. Asi la prueba
 * comprueba que las migraciones los revocan de verdad.
 */
const emulateSupabaseDefaults = async (db: Db): Promise<void> => {
  for (const role of ['anon', 'authenticated']) {
    await db.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
           CREATE ROLE ${role} NOLOGIN;
         END IF;
       END $$`,
    );
  }
  await db.query('GRANT USAGE ON SCHEMA public TO anon, authenticated');
  await db.query(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated',
  );
};

export const resetDatabase = async (db: Db): Promise<void> => {
  await db.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.query('CREATE SCHEMA public');
  await emulateSupabaseDefaults(db);
  await applyMigrations(db);
};

export const connectTestDb = (): Db => {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL no definida');
  assertSafeTestDatabase(testDatabaseUrl);
  return createDb(testDatabaseUrl, { max: 12 });
};
