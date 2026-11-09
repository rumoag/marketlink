-- U7 Transversales: registro de copias de seguridad, acciones de auditoria nuevas y trabajos
-- periodicos de limpieza de datos personales y de alertas de seguridad. Migracion aditiva.
-- Ninguna tabla nueva guarda datos personales.

-- ---------------------------------------------------------------------------------------------
-- Acciones de auditoria nuevas
-- ---------------------------------------------------------------------------------------------
alter table public.audit_events drop constraint if exists audit_events_action_check;
alter table public.audit_events
  add constraint audit_events_action_check
  check (action in ('auth_failure', 'authz_denied', 'rate_limited', 'webhook_signature_invalid',
                    'mfa_failure', 'job_failed',
                    'checkout_created', 'payment_confirmed', 'duplicate_payment',
                    'refund_requested', 'refund_done', 'refund_failed',
                    'manual_payment_confirmed', 'operator_alert', 'personal_data_purged',
                    'reconciliation_mismatch',
                    'label_downloaded', 'invoice_generated', 'shipment_draft_created',
                    'labels_purged',
                    'settlement_done', 'settlement_blocked', 'withdrawal_requested',
                    'withdrawal_done', 'withdrawal_failed', 'manual_release',
                    'ledger_mismatch', 'balance_mismatch', 'finance_exported',
                    'charge_refunded_external', 'dispute_opened',
                    'operator_login', 'operator_locked', 'operator_view_order',
                    'operator_retry_draft', 'operator_flag_open', 'operator_flag_close',
                    'operator_note', 'operator_sizes_changed', 'operator_release',
                    'operator_refund',
                    'personal_data_erased', 'security_alert'));

-- ---------------------------------------------------------------------------------------------
-- backup_runs: ultima copia correcta (la escribe el flujo de copia si su rol lo permite)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.backup_runs (
  id         uuid primary key default gen_random_uuid(),
  at         timestamptz not null default now(),
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  checksum   text check (checksum is null or char_length(checksum) = 64)
);

create index if not exists backup_runs_at_idx on public.backup_runs (at desc);

alter table public.backup_runs enable row level security;
revoke all on public.backup_runs from anon, authenticated;
grant select, insert on public.backup_runs to marketlink_app;  -- sin UPDATE ni DELETE

drop policy if exists backup_runs_read on public.backup_runs;
create policy backup_runs_read on public.backup_runs for select to marketlink_app
  using (public.app_is_system());

drop policy if exists backup_runs_insert on public.backup_runs;
create policy backup_runs_insert on public.backup_runs for insert to marketlink_app
  with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- Indices para la limpieza (pedidos con datos personales) y los candidatos por fecha
-- ---------------------------------------------------------------------------------------------
create index if not exists orders_personal_idx
  on public.orders (created_at) where personal_purged_at is null;

-- ---------------------------------------------------------------------------------------------
-- Trabajos periodicos (condicional a pg_cron, como en U1 a U6)
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('marketlink-purge-personal-data', '30 4 * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('purge_personal_data', 'purge-personal-data:' || to_char(now(), 'YYYY-MM-DD'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
    perform cron.schedule('marketlink-security-alerts', '*/5 * * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('security_alerts', 'security-alerts:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
  end if;
end
$$;
