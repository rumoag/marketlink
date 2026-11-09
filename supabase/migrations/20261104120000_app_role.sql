-- U1 Fundacion: rol de la aplicacion con privilegios minimos.
-- Migracion aditiva. El rol se crea sin acceso (NOLOGIN); la contrasena y el LOGIN se asignan
-- fuera del repositorio (ver docs/runbooks/rotacion-secretos.md):
--   ALTER ROLE marketlink_app LOGIN PASSWORD '<secreto>';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'marketlink_app') then
    create role marketlink_app nologin;
  end if;
  -- En Supabase estos roles ya existen; se crean solo para que las migraciones sean
  -- autocontenidas en un Postgres corriente (CI y pruebas de integracion).
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

grant usage on schema public to marketlink_app;
