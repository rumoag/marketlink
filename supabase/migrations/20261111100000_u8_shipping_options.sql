-- U8 Opciones de envio con precio. Migracion aditiva y reversible.
--
-- 1. listings.origins: conjunto de origenes que la artista acepta (punto, recogida o ambos). Se rellena
--    desde la columna antigua `modality`, que se MANTIENE (D-U8-3). Un disparador mantiene `modality`
--    coherente con `origins` para que el codigo anterior siga funcionando durante el despliegue y la
--    vuelta atras. Otra migracion posterior eliminara `modality` cuando U8 este estable.
-- 2. provider_cache: cache compartida de respuestas de Packlink con caducidad (ADR 0033). Sin datos
--    personales: solo servicios y puntos publicos para un codigo postal.
-- 3. Accion de auditoria `delivery_selection_rejected`.
--
-- Vuelta atras: drop trigger/function, drop column origins, drop table provider_cache; las acciones de
-- auditoria sobrantes no estorban.

-- ---------------------------------------------------------------------------------------------
-- 1. listings.origins
-- ---------------------------------------------------------------------------------------------
alter table public.listings add column if not exists origins text[];

update public.listings set origins = array[modality] where origins is null;

alter table public.listings alter column origins set not null;

alter table public.listings drop constraint if exists listings_origins_check;
alter table public.listings
  add constraint listings_origins_check
  check (
    cardinality(origins) between 1 and 2
    and origins <@ array['punto', 'recogida']::text[]
  );

-- `modality` sigue siendo obligatoria y se deriva de `origins` (el primero que corresponda: punto si se
-- acepta, si no recogida). El codigo anterior que solo escribe `modality` recibe `origins = {modality}`.
create or replace function public.listings_sync_origins() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.origins is null then
      new.origins := array[new.modality];
    end if;
  elsif new.origins is not distinct from old.origins and new.modality is distinct from old.modality then
    -- Codigo anterior: solo cambio `modality`.
    new.origins := array[new.modality];
  end if;
  new.modality := case when 'punto' = any (new.origins) then 'punto' else 'recogida' end;
  return new;
end;
$$;

drop trigger if exists listings_sync_origins on public.listings;
create trigger listings_sync_origins
  before insert or update on public.listings
  for each row execute function public.listings_sync_origins();

-- ---------------------------------------------------------------------------------------------
-- 2. provider_cache
-- ---------------------------------------------------------------------------------------------
create table if not exists public.provider_cache (
  key        text primary key check (char_length(key) between 1 and 200),
  payload    jsonb not null,
  expires_at timestamptz not null
);

create index if not exists provider_cache_expires_idx on public.provider_cache (expires_at);

alter table public.provider_cache enable row level security;
revoke all on public.provider_cache from anon, authenticated;
grant select, insert, update, delete on public.provider_cache to marketlink_app;

drop policy if exists provider_cache_app on public.provider_cache;
create policy provider_cache_app on public.provider_cache
  for all to marketlink_app using (true) with check (true);

-- Purga diaria de entradas caducadas (04:10 UTC), directo en SQL: no depende de la cola.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('marketlink-purge-provider-cache', '10 4 * * *', $job$
      delete from public.provider_cache where expires_at < now()
    $job$);
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Auditoria
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
                    'personal_data_erased', 'security_alert',
                    'delivery_selection_rejected'));
