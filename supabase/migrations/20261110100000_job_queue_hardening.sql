-- Endurecimiento de la cola (ADR 0030). Aditiva y condicional (solo actua si pg_cron esta disponible).
--
-- Problema observado en el despliegue de prueba: sin consumidor de la cola (faltaban los secretos del
-- Vault) los trabajos periodicos se acumularon por miles, uno por minuto y tipo, porque su clave de
-- deduplicacion incluia el minuto; los trabajos de eventos (pagos) esperaron detras de ellos.
--
-- 1. Los periodicos cada minuto, 5 o 15 minutos usan una clave fija por tipo: como mucho UNO
--    pendiente o en curso a la vez (BR-J7). Si el consumidor se para, la cola no crece.
-- 2. Los trabajos terminados se purgan a los 7 dias para que la tabla no crezca sin limite.
-- (El orden de reclamo, eventos antes que periodicos, esta en el codigo del almacen.)
--
-- `cron.schedule` con el mismo nombre actualiza la programacion existente.

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then

    perform cron.schedule('marketlink-expire-stale-orders', '* * * * *', $job$
      insert into public.jobs (type, dedupe_key) values ('expire_stale_orders', 'periodic:expire_stale_orders')
      on conflict (dedupe_key) where status in ('pending', 'running') do nothing
    $job$);

    perform cron.schedule('marketlink-poll-shipments', '* * * * *', $job$
      insert into public.jobs (type, dedupe_key) values ('poll_shipments', 'periodic:poll_shipments')
      on conflict (dedupe_key) where status in ('pending', 'running') do nothing
    $job$);

    perform cron.schedule('marketlink-dispatch-notifications', '* * * * *', $job$
      insert into public.jobs (type, dedupe_key) values ('dispatch_notifications', 'periodic:dispatch_notifications')
      on conflict (dedupe_key) where status in ('pending', 'running') do nothing
    $job$);

    perform cron.schedule('marketlink-retry-settlements', '* * * * *', $job$
      insert into public.jobs (type, dedupe_key) values ('retry_settlements', 'periodic:retry_settlements')
      on conflict (dedupe_key) where status in ('pending', 'running') do nothing
    $job$);

    perform cron.schedule('marketlink-remind-pickup', '*/15 * * * *', $job$
      insert into public.jobs (type, dedupe_key) values ('remind_pickup', 'periodic:remind_pickup')
      on conflict (dedupe_key) where status in ('pending', 'running') do nothing
    $job$);

    perform cron.schedule('marketlink-remind-pay-label', '*/15 * * * *', $job$
      insert into public.jobs (type, dedupe_key) values ('remind_pay_label', 'periodic:remind_pay_label')
      on conflict (dedupe_key) where status in ('pending', 'running') do nothing
    $job$);

    perform cron.schedule('marketlink-withdraw-payout', '*/5 * * * *', $job$
      insert into public.jobs (type, dedupe_key) values ('withdraw_payout', 'periodic:withdraw_payout')
      on conflict (dedupe_key) where status in ('pending', 'running') do nothing
    $job$);

    perform cron.schedule('marketlink-security-alerts', '*/5 * * * *', $job$
      insert into public.jobs (type, dedupe_key) values ('security_alerts', 'periodic:security_alerts')
      on conflict (dedupe_key) where status in ('pending', 'running') do nothing
    $job$);

    -- Purga de trabajos terminados a los 7 dias (03:40 UTC). Directo en SQL: no depende de la cola.
    perform cron.schedule('marketlink-purge-finished-jobs', '40 3 * * *', $job$
      delete from public.jobs
      where status in ('succeeded', 'cancelled')
        and completed_at is not null
        and completed_at < now() - interval '7 days'
    $job$);

  end if;
end
$$;
