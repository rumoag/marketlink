-- U3 Compra y pago: trabajos programados. Aditiva y condicional (igual que la de U1: solo actua si
-- pg_cron esta disponible; si no, se aplica el plan alterno documentado en el ADR 0009).

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Respaldo por reloj (BR3-WH6): cada minuto.
    perform cron.schedule(
      'marketlink-expire-stale-orders',
      '* * * * *',
      $job$
        insert into public.jobs (type, dedupe_key)
        values ('expire_stale_orders', 'expire-orders:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI'))
        on conflict (dedupe_key) where status in ('pending', 'running') do nothing
      $job$
    );

    -- Conciliacion diaria con Stripe (NFR-U3-09): 03:30 UTC.
    perform cron.schedule(
      'marketlink-reconcile-stripe',
      '30 3 * * *',
      $job$
        insert into public.jobs (type, dedupe_key)
        values ('reconcile_stripe', 'reconcile:' || to_char(now(), 'YYYY-MM-DD'))
        on conflict (dedupe_key) where status in ('pending', 'running') do nothing
      $job$
    );

    -- Borrado de datos personales de pedidos cancelados y expirados (NFR-U3-26): 04:00 UTC.
    perform cron.schedule(
      'marketlink-purge-unpaid-orders',
      '0 4 * * *',
      $job$
        insert into public.jobs (type, dedupe_key)
        values ('purge_unpaid_orders', 'purge-unpaid:' || to_char(now(), 'YYYY-MM-DD'))
        on conflict (dedupe_key) where status in ('pending', 'running') do nothing
      $job$
    );
  end if;
end
$$;
