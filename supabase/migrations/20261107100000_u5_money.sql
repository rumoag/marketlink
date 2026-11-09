-- U5 Dinero: libro de solo insercion, saldos, liquidaciones, retiradas y reembolsos. Migracion aditiva.
--
-- Datos personales: ninguna de estas tablas guarda nombre, email, telefono ni direccion.
-- Todos los importes son centimos enteros. El libro (ledger_entries) solo admite SELECT e INSERT
-- para el rol de la aplicacion: ni UPDATE ni DELETE.

-- ---------------------------------------------------------------------------------------------
-- orders: identificador del cobro (ch_...) para ligar la transferencia al cobro original
-- ---------------------------------------------------------------------------------------------
alter table public.orders
  add column if not exists charge_id text check (charge_id is null or char_length(charge_id) between 3 and 120);

-- ---------------------------------------------------------------------------------------------
-- Eventos de pedido, acciones de auditoria y tipos de notificacion nuevos
-- ---------------------------------------------------------------------------------------------
alter table public.order_events drop constraint if exists order_events_kind_check;
alter table public.order_events
  add constraint order_events_kind_check
  check (kind in ('creado', 'pago_iniciado', 'pago_confirmado', 'sesion_expirada',
                  'cancelado_por_comprador', 'reserva_liberada', 'obra_vendida',
                  'doble_pago_detectado', 'reembolso_solicitado', 'reembolso_hecho',
                  'reembolso_fallido', 'cobro_manual_confirmado', 'datos_purgados',
                  'borrador_creado', 'borrador_fallido', 'etiqueta_lista', 'en_transito',
                  'entregado', 'incidencia_envio', 'recogida_elegida',
                  'liquidado', 'reembolso_parcial', 'liberacion_manual',
                  'entrega_sin_confirmar'));

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
                    'charge_refunded_external', 'dispute_opened'));

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('pedido_nuevo_artista', 'confirmacion_compradora',
                  'paga_envio_operador', 'elegir_recogida_artista',
                  'recordatorio_recogida_artista', 'recogida_sin_elegir_operador',
                  'etiqueta_lista_artista', 'en_camino_compradora',
                  'entregado_compradora', 'entregado_artista',
                  'incidencia_artista', 'incidencia_compradora',
                  'incidencia_operador', 'recordatorio_pago_envio_operador',
                  'liquidacion_artista', 'retirada_artista'));

-- La retirada no pertenece a un pedido: order_id pasa a ser opcional y la unicidad se mantiene
-- por pedido y tipo cuando existe pedido; las retiradas se identifican con dedupe_ref.
alter table public.notifications alter column order_id drop not null;
alter table public.notifications
  add column if not exists dedupe_ref text check (dedupe_ref is null or char_length(dedupe_ref) <= 80),
  add column if not exists amount_cents integer check (amount_cents is null or amount_cents > 0);
create unique index if not exists notifications_dedupe_ref_idx
  on public.notifications (type, dedupe_ref) where dedupe_ref is not null;

-- ---------------------------------------------------------------------------------------------
-- ledger_entries: libro de solo insercion
-- ---------------------------------------------------------------------------------------------
create table if not exists public.ledger_entries (
  id          uuid primary key default gen_random_uuid(),
  at          timestamptz not null default now(),
  order_id    uuid references public.orders (id),
  artist_id   uuid,
  kind        text not null
              check (kind in ('cobro', 'retencion', 'envio_plataforma', 'comision', 'liquidacion',
                              'retirada', 'reembolso', 'ajuste')),
  bucket      text not null check (bucket in ('stripe', 'retenido', 'disponible', 'plataforma')),
  delta_cents integer not null check (delta_cents <> 0),
  ref         text check (ref is null or char_length(ref) <= 120),
  reason_code text check (reason_code is null or char_length(reason_code) <= 60),
  -- clave de idempotencia de la escritura: misma clave, mismo movimiento una sola vez
  entry_key   text not null unique check (char_length(entry_key) between 3 and 160)
);

create index if not exists ledger_entries_order_idx on public.ledger_entries (order_id);
create index if not exists ledger_entries_artist_idx on public.ledger_entries (artist_id, bucket);
create index if not exists ledger_entries_at_idx on public.ledger_entries (at);

-- un pedido solo se cobra y retiene una vez, y solo se liquida una vez por cubo
create unique index if not exists ledger_entries_payment_once_idx
  on public.ledger_entries (order_id, kind)
  where order_id is not null and kind in ('cobro', 'retencion', 'envio_plataforma', 'comision');
create unique index if not exists ledger_entries_settlement_once_idx
  on public.ledger_entries (order_id, kind, bucket)
  where order_id is not null and kind = 'liquidacion';

alter table public.ledger_entries enable row level security;
revoke all on public.ledger_entries from anon, authenticated;
grant select, insert on public.ledger_entries to marketlink_app;  -- sin UPDATE ni DELETE

drop policy if exists ledger_entries_read on public.ledger_entries;
create policy ledger_entries_read on public.ledger_entries for select to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id());

drop policy if exists ledger_entries_insert on public.ledger_entries;
create policy ledger_entries_insert on public.ledger_entries for insert to marketlink_app
  with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- artist_balances: saldo derivado del libro, actualizado en la misma transaccion
-- ---------------------------------------------------------------------------------------------
create table if not exists public.artist_balances (
  artist_id        uuid primary key,
  retained_cents   integer not null default 0 check (retained_cents >= 0),
  available_cents  integer not null default 0 check (available_cents >= 0),
  withdrawal_count integer not null default 0 check (withdrawal_count >= 0),
  updated_at       timestamptz not null default now()
);

alter table public.artist_balances enable row level security;
revoke all on public.artist_balances from anon, authenticated;
grant select, insert, update on public.artist_balances to marketlink_app;  -- sin DELETE

drop policy if exists artist_balances_read on public.artist_balances;
create policy artist_balances_read on public.artist_balances for select to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id());

drop policy if exists artist_balances_insert on public.artist_balances;
create policy artist_balances_insert on public.artist_balances for insert to marketlink_app
  with check (public.app_is_system());

drop policy if exists artist_balances_update on public.artist_balances;
create policy artist_balances_update on public.artist_balances for update to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- settlements: una por pedido (bandeja de salida de la liquidacion)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.settlements (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null unique references public.orders (id),
  artist_id       uuid not null,
  amount_cents    integer not null check (amount_cents >= 0),
  status          text not null default 'pendiente'
                  check (status in ('pendiente', 'transferida', 'fallida', 'anulada')),
  block_reason    text check (block_reason is null or block_reason in
                  ('cuenta_no_activa', 'incidencia_abierta', 'reembolso_en_curso', 'retraso',
                   'sin_cargo')),
  transfer_ref    text check (transfer_ref is null or char_length(transfer_ref) <= 120),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  released_by     text check (released_by is null or released_by in ('automatica', 'manual')),
  alerted_at      timestamptz,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists settlements_pending_idx
  on public.settlements (next_attempt_at) where status = 'pendiente';
create index if not exists settlements_artist_idx on public.settlements (artist_id, status);

alter table public.settlements enable row level security;
revoke all on public.settlements from anon, authenticated;
grant select, insert, update on public.settlements to marketlink_app;  -- sin DELETE

drop policy if exists settlements_read on public.settlements;
create policy settlements_read on public.settlements for select to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id());

drop policy if exists settlements_insert on public.settlements;
create policy settlements_insert on public.settlements for insert to marketlink_app
  with check (public.app_is_system());

drop policy if exists settlements_update on public.settlements;
create policy settlements_update on public.settlements for update to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- withdrawals: una por artista y numero de retirada
-- ---------------------------------------------------------------------------------------------
create table if not exists public.withdrawals (
  id              uuid primary key default gen_random_uuid(),
  artist_id       uuid not null,
  seq             integer not null check (seq >= 1),
  amount_cents    integer not null check (amount_cents > 0),
  status          text not null default 'solicitada'
                  check (status in ('solicitada', 'enviada', 'fallida')),
  payout_ref      text check (payout_ref is null or char_length(payout_ref) <= 120),
  idempotency_key text not null unique check (char_length(idempotency_key) between 3 and 120),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  unique (artist_id, seq)
);

create index if not exists withdrawals_open_idx
  on public.withdrawals (next_attempt_at) where status = 'solicitada';

alter table public.withdrawals enable row level security;
revoke all on public.withdrawals from anon, authenticated;
grant select, insert, update on public.withdrawals to marketlink_app;  -- sin DELETE

drop policy if exists withdrawals_read on public.withdrawals;
create policy withdrawals_read on public.withdrawals for select to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id());

drop policy if exists withdrawals_insert on public.withdrawals;
create policy withdrawals_insert on public.withdrawals for insert to marketlink_app
  with check (public.app_is_system() or artist_id = public.app_artist_id());

drop policy if exists withdrawals_update on public.withdrawals;
create policy withdrawals_update on public.withdrawals for update to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- refunds: una por pedido y numero de reembolso
-- ---------------------------------------------------------------------------------------------
create table if not exists public.refunds (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders (id),
  seq                  integer not null check (seq >= 1),
  amount_cents         integer not null check (amount_cents > 0),
  shipping_part_cents  integer not null check (shipping_part_cents >= 0),
  artist_part_cents    integer not null check (artist_part_cents >= 0),
  status               text not null default 'solicitado'
                       check (status in ('solicitado', 'hecho', 'fallido')),
  refund_ref           text check (refund_ref is null or char_length(refund_ref) <= 120),
  reason_code          text not null check (char_length(reason_code) between 1 and 60),
  requested_by         text not null check (requested_by in ('operador', 'sistema')),
  created_at           timestamptz not null default now(),
  completed_at         timestamptz,
  unique (order_id, seq),
  check (amount_cents = shipping_part_cents + artist_part_cents)
);

alter table public.refunds enable row level security;
revoke all on public.refunds from anon, authenticated;
grant select, insert, update on public.refunds to marketlink_app;  -- sin DELETE

drop policy if exists refunds_read on public.refunds;
create policy refunds_read on public.refunds for select to marketlink_app
  using (public.app_is_system()
         or exists (select 1 from public.orders o
                     where o.id = refunds.order_id and o.artist_id = public.app_artist_id()));

drop policy if exists refunds_insert on public.refunds;
create policy refunds_insert on public.refunds for insert to marketlink_app
  with check (public.app_is_system());

drop policy if exists refunds_update on public.refunds;
create policy refunds_update on public.refunds for update to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- Bucket de exportaciones contables: privado, solo CSV, 5 MB (solo aplica en Supabase)
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('finance-exports', 'finance-exports', false, 5242880, array['text/csv'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Trabajos periodicos (condicional a pg_cron, como en U1, U3 y U4)
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('marketlink-retry-settlements', '* * * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('retry_settlements', 'retry-settlements:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
    perform cron.schedule('marketlink-withdraw-payout', '*/5 * * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('withdraw_payout', 'withdraw-payout:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
    perform cron.schedule('marketlink-reconcile-ledger', '45 3 * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('reconcile_ledger', 'reconcile-ledger:' || to_char(now(), 'YYYY-MM-DD'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
    perform cron.schedule('marketlink-recompute-balances', '50 3 * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('recompute_balances', 'recompute-balances:' || to_char(now(), 'YYYY-MM-DD'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
    perform cron.schedule('marketlink-stale-deliveries', '10 4 * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('stale_deliveries', 'stale-deliveries:' || to_char(now(), 'YYYY-MM-DD'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
    perform cron.schedule('marketlink-export-finance', '0 5 1 * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('export_finance', 'export-finance:' || to_char(now(), 'YYYY-MM'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
  end if;
end
$$;
