-- U6 Panel del operador: estado del segundo factor, incidencias manuales, notas internas y
-- contador de visitas. Migracion aditiva. Todas las tablas nuevas son solo del contexto de
-- sistema (las artistas no leen nada de esto) y no guardan datos personales.

-- ---------------------------------------------------------------------------------------------
-- Eventos de pedido y acciones de auditoria nuevos
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
                  'entrega_sin_confirmar', 'borrador_reintentado'));

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
                    'operator_refund'));

-- ---------------------------------------------------------------------------------------------
-- orders: metodo de pago real (tarjeta o Bizum), para las metricas; se rellena al conocer el cobro
-- ---------------------------------------------------------------------------------------------
alter table public.orders
  add column if not exists payment_method text
  check (payment_method is null or payment_method in ('tarjeta', 'bizum'));

-- ---------------------------------------------------------------------------------------------
-- operator_totp_state: ultimo paso TOTP aceptado, fallos recientes y bloqueo (por operador)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.operator_totp_state (
  email        text primary key check (char_length(email) between 3 and 254),
  last_step    bigint not null default 0 check (last_step >= 0),
  failures     integer not null default 0 check (failures >= 0),
  window_start timestamptz,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

alter table public.operator_totp_state enable row level security;
revoke all on public.operator_totp_state from anon, authenticated;
grant select, insert, update on public.operator_totp_state to marketlink_app;  -- sin DELETE

drop policy if exists operator_totp_state_system on public.operator_totp_state;
create policy operator_totp_state_system on public.operator_totp_state for all to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- order_flags: incidencia manual (marca independiente del estado del pedido)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.order_flags (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders (id),
  reason     text not null check (char_length(reason) between 1 and 120),
  opened_by  text not null check (char_length(opened_by) between 3 and 254),
  opened_at  timestamptz not null default now(),
  resolution text check (resolution is null or char_length(resolution) between 1 and 280),
  closed_by  text check (closed_by is null or char_length(closed_by) between 3 and 254),
  closed_at  timestamptz,
  check ((closed_at is null) = (resolution is null))
);

-- una incidencia manual abierta como maximo por pedido
create unique index if not exists order_flags_one_open_idx
  on public.order_flags (order_id) where closed_at is null;
create index if not exists order_flags_order_idx on public.order_flags (order_id);

alter table public.order_flags enable row level security;
revoke all on public.order_flags from anon, authenticated;
grant select, insert, update on public.order_flags to marketlink_app;  -- sin DELETE

drop policy if exists order_flags_system on public.order_flags;
create policy order_flags_system on public.order_flags for all to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- operator_notes: notas internas de solo insercion
-- ---------------------------------------------------------------------------------------------
create table if not exists public.operator_notes (
  id       uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id),
  author   text not null check (char_length(author) between 3 and 254),
  at       timestamptz not null default now(),
  text     text not null check (char_length(text) between 1 and 500),
  -- clave de un solo uso del formulario: un doble envio no crea dos notas
  form_key text unique check (form_key is null or char_length(form_key) between 8 and 64)
);

create index if not exists operator_notes_order_idx on public.operator_notes (order_id, at);

alter table public.operator_notes enable row level security;
revoke all on public.operator_notes from anon, authenticated;
grant select, insert on public.operator_notes to marketlink_app;  -- sin UPDATE ni DELETE

drop policy if exists operator_notes_read on public.operator_notes;
create policy operator_notes_read on public.operator_notes for select to marketlink_app
  using (public.app_is_system());

drop policy if exists operator_notes_insert on public.operator_notes;
create policy operator_notes_insert on public.operator_notes for insert to marketlink_app
  with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- listing_views: contador agregado por obra y dia (sin IP, cookie ni identificador)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.listing_views (
  listing_id uuid not null references public.listings (id),
  day        date not null,
  count      integer not null default 0 check (count >= 0),
  primary key (listing_id, day)
);

create index if not exists listing_views_day_idx on public.listing_views (day);

alter table public.listing_views enable row level security;
revoke all on public.listing_views from anon, authenticated;
grant select, insert, update, delete on public.listing_views to marketlink_app;  -- DELETE: retencion

drop policy if exists listing_views_system on public.listing_views;
create policy listing_views_system on public.listing_views for all to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- Indices de la lista de pedidos del operador
-- ---------------------------------------------------------------------------------------------
create index if not exists orders_status_created_idx on public.orders (status, created_at desc);
create index if not exists orders_artist_created_idx on public.orders (artist_id, created_at desc);
create index if not exists orders_created_idx on public.orders (created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Trabajo periodico (condicional a pg_cron, como en U1, U3, U4 y U5)
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('marketlink-purge-listing-views', '20 4 * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('purge_listing_views', 'purge-listing-views:' || to_char(now(), 'YYYY-MM-DD'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
  end if;
end
$$;
