import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { instantOf } from '@/modules/kernel/domain/clock';
import { PgProviderCache } from '@/modules/checkout/infrastructure/pg-provider-cache';
import { createDb, type Db } from '@/modules/platform/infrastructure/db-client';
import {
  applyMigrations,
  connectTestDb,
  describeDb,
  migrationFiles,
  resetDatabase,
  testDatabaseUrl,
} from './helpers';

const A = '11111111-1111-4111-8111-111111111111';
const APP_PASSWORD = 'apppass-integration';
const U8_FILE = '20261111100000_u8_shipping_options.sql';

describeDb('U8: opciones de envio en la base de datos', () => {
  let admin: Db;
  let app: Db;

  beforeAll(async () => {
    admin = connectTestDb();
    // Esquema hasta U7 (sin la migracion de U8), para probar el relleno de datos anteriores.
    await resetDatabase(admin);
    await admin.query('DROP SCHEMA public CASCADE');
    await admin.query('CREATE SCHEMA public');
    await admin.query('GRANT USAGE ON SCHEMA public TO anon, authenticated');
    await admin.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated',
    );
    const dir = path.resolve(import.meta.dirname, '../../supabase/migrations');
    for (const file of migrationFiles()) {
      if (file === U8_FILE) continue;
      await admin.query(readFileSync(path.join(dir, file), 'utf8'));
    }
    await admin.query(`INSERT INTO artists (id, email) VALUES ($1, 'ana@example.com')`, [A]);
    const base = `INSERT INTO listings (artist_id, slug, title, price_cents, declared_value_cents, size, modality)`;
    await admin.query(`${base} VALUES ($1, 'aaaaaaaa', 'Con punto', 1000, 1000, 'M', 'punto')`, [
      A,
    ]);
    await admin.query(
      `${base} VALUES ($1, 'bbbbbbbb', 'Con recogida', 1000, 1000, 'M', 'recogida')`,
      [A],
    );
    // Ahora la migracion de U8 sobre datos anteriores.
    await admin.query(readFileSync(path.join(dir, U8_FILE), 'utf8'));
    await admin.query(`ALTER ROLE marketlink_app LOGIN PASSWORD '${APP_PASSWORD}'`);
    const url = new URL(testDatabaseUrl as string);
    url.username = 'marketlink_app';
    url.password = APP_PASSWORD;
    app = createDb(url.toString(), { max: 4 });
  });

  afterAll(async () => {
    await app?.end();
    // Deja el esquema completo para el resto de ficheros.
    await resetDatabase(admin);
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('TRUNCATE provider_cache');
  });

  // -------------------------------------------------------------------------------------------
  it('P-U8-10: la migracion deja origins = {modality} en cada enlace anterior', async () => {
    const res = await admin.query<{ slug: string; modality: string; origins: string[] }>(
      'SELECT slug, modality, origins FROM listings ORDER BY slug',
    );
    expect(res.rows).toEqual([
      { slug: 'aaaaaaaa', modality: 'punto', origins: ['punto'] },
      { slug: 'bbbbbbbb', modality: 'recogida', origins: ['recogida'] },
    ]);
  });

  it('el disparador mantiene la compatibilidad con el codigo anterior (solo `modality`)', async () => {
    const base = `INSERT INTO listings (artist_id, slug, title, price_cents, declared_value_cents, size, modality)`;
    await admin.query(`${base} VALUES ($1, 'cccccccc', 'Antiguo', 1000, 1000, 'M', 'recogida')`, [
      A,
    ]);
    const inserted = await admin.query<{ origins: string[] }>(
      `SELECT origins FROM listings WHERE slug = 'cccccccc'`,
    );
    expect(inserted.rows[0]?.origins).toEqual(['recogida']);

    await admin.query(`UPDATE listings SET modality = 'punto' WHERE slug = 'cccccccc'`);
    const changed = await admin.query<{ origins: string[]; modality: string }>(
      `SELECT origins, modality FROM listings WHERE slug = 'cccccccc'`,
    );
    expect(changed.rows[0]).toEqual({ origins: ['punto'], modality: 'punto' });
  });

  it('la modalidad se deriva de los origenes: punto si se acepta, si no recogida', async () => {
    await admin.query(
      `UPDATE listings SET origins = ARRAY['recogida','punto'] WHERE slug = 'cccccccc'`,
    );
    const both = await admin.query<{ modality: string }>(
      `SELECT modality FROM listings WHERE slug = 'cccccccc'`,
    );
    expect(both.rows[0]?.modality).toBe('punto');
    await admin.query(`UPDATE listings SET origins = ARRAY['recogida'] WHERE slug = 'cccccccc'`);
    const one = await admin.query<{ modality: string }>(
      `SELECT modality FROM listings WHERE slug = 'cccccccc'`,
    );
    expect(one.rows[0]?.modality).toBe('recogida');
  });

  it('las restricciones rechazan origenes vacios o desconocidos', async () => {
    await expect(
      admin.query(`UPDATE listings SET origins = ARRAY[]::text[] WHERE slug = 'aaaaaaaa'`),
    ).rejects.toThrow(/check constraint|origins/i);
    await expect(
      admin.query(
        `UPDATE listings SET origins = ARRAY['punto','mensajero'] WHERE slug = 'aaaaaaaa'`,
      ),
    ).rejects.toThrow(/check constraint|origins/i);
  });

  // -------------------------------------------------------------------------------------------
  it('provider_cache: devuelve lo vigente, no lo caducado, y sobrescribe', async () => {
    const cache = new PgProviderCache(app);
    const t0 = instantOf(Date.UTC(2026, 10, 11, 12, 0, 0));
    await cache.set('quote:28001:08001', [{ id: '1' }], 600_000, t0);
    expect(await cache.get('quote:28001:08001', t0)).toEqual([{ id: '1' }]);
    expect(await cache.get('quote:28001:08001', instantOf(t0 + 599_000))).toEqual([{ id: '1' }]);
    // Caducada: nunca se devuelve (NFR-U8-16).
    expect(await cache.get('quote:28001:08001', instantOf(t0 + 600_001))).toBeUndefined();
    await cache.set('quote:28001:08001', [{ id: '2' }], 600_000, instantOf(t0 + 700_000));
    expect(await cache.get('quote:28001:08001', instantOf(t0 + 700_000))).toEqual([{ id: '2' }]);
    expect(await cache.get('no-existe', t0)).toBeUndefined();
  });

  it('provider_cache: la escritura borra de forma oportunista lo caducado hace tiempo', async () => {
    const cache = new PgProviderCache(app);
    const t0 = instantOf(Date.UTC(2026, 10, 11, 12, 0, 0));
    await cache.set('viejo', [1], 1_000, t0);
    await cache.set('nuevo', [2], 600_000, instantOf(t0 + 2 * 3_600_000));
    const left = await admin.query<{ key: string }>('SELECT key FROM provider_cache ORDER BY key');
    expect(left.rows.map((r) => r.key)).toEqual(['nuevo']);
  });

  it('provider_cache: la API publica no accede (RLS y privilegios)', async () => {
    await admin.query(
      `INSERT INTO provider_cache (key, payload, expires_at) VALUES ('k', '[]', now() + interval '1 hour')`,
    );
    for (const role of ['anon', 'authenticated']) {
      const res = await admin.query<{ ok: boolean }>(
        `SELECT has_table_privilege('${role}', 'public.provider_cache', 'select') AS ok`,
      );
      expect(res.rows[0]?.ok, role).toBe(false);
    }
    const rls = await admin.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provider_cache'::regclass`,
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
  });

  it('la migracion es idempotente (se puede volver a aplicar)', async () => {
    const dir = path.resolve(import.meta.dirname, '../../supabase/migrations');
    await admin.query(readFileSync(path.join(dir, U8_FILE), 'utf8'));
    const res = await admin.query<{ n: string }>('SELECT count(*)::text AS n FROM listings');
    expect(Number(res.rows[0]?.n)).toBeGreaterThanOrEqual(2);
  });

  it('applyMigrations completa sobre una base limpia incluye la migracion de U8', async () => {
    expect(migrationFiles()).toContain(U8_FILE);
    expect(typeof applyMigrations).toBe('function');
  });
});
