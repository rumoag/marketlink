-- U1 Fundacion: trabajos programados (P-RES-3). Aditiva y condicional.
-- Requiere pg_cron y pg_net; su disponibilidad en el plan gratuito de Supabase se verifica al crear
-- el proyecto. Si no estan, esta migracion no hace nada y se aplica el plan alterno documentado
-- (docs/adr/0009-cola-de-trabajos.md).
--
-- Secretos: se leen de Supabase Vault en tiempo de ejecucion (nunca viven en el repositorio):
--   select vault.create_secret('https://<tu-dominio>', 'marketlink_app_url');
--   select vault.create_secret('<INTERNAL_JOBS_SECRET>', 'marketlink_jobs_secret');

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net')
     and exists (select 1 from information_schema.schemata where schema_name = 'vault') then

    create extension if not exists pg_cron;
    create extension if not exists pg_net;

    -- Red de seguridad: procesa la cola cada minuto (ademas del disparo inmediato).
    perform cron.schedule(
      'marketlink-run-jobs',
      '* * * * *',
      $job$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'marketlink_app_url')
                 || '/api/internal/jobs/run',
          headers := jsonb_build_object(
            'x-internal-secret',
            (select decrypted_secret from vault.decrypted_secrets where name = 'marketlink_jobs_secret')
          ),
          timeout_milliseconds := 30000
        )
      $job$
    );

    -- Limpieza diaria de contadores de limitacion de tasa (encola un trabajo con clave diaria).
    perform cron.schedule(
      'marketlink-cleanup-counters',
      '0 3 * * *',
      $job$
        insert into public.jobs (type, dedupe_key)
        values ('cleanup_rate_limit_counters', 'cleanup:' || to_char(now(), 'YYYY-MM-DD'))
        on conflict (dedupe_key) where status in ('pending', 'running') do nothing
      $job$
    );
  end if;
end
$$;
