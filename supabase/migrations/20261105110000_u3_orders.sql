-- U3 Compra y pago: pedidos, eventos de pedido (solo insercion), telefono de Bizum del perfil y
-- acciones de auditoria nuevas. Migracion aditiva y compatible hacia atras.
--
-- Datos personales de la compradora: solo en orders.buyer y orders.destination (se vacian con
-- purge_unpaid_orders). Nunca en order_events, audit_events ni en trabajos.

-- ---------------------------------------------------------------------------------------------
-- Telefono de Bizum de la artista (opcional; solo se muestra en el modo manual)
-- ---------------------------------------------------------------------------------------------
alter table public.artists
  add column if not exists bizum_phone text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'artists_bizum_phone_check'
  ) then
    alter table public.artists
      add constraint artists_bizum_phone_check
      check (bizum_phone is null or bizum_phone ~ '^\+34[6-9][0-9]{8}$');
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Acciones de auditoria nuevas (NFR-U3-23)
-- ---------------------------------------------------------------------------------------------
alter table public.audit_events drop constraint if exists audit_events_action_check;
alter table public.audit_events
  add constraint audit_events_action_check
  check (action in ('auth_failure', 'authz_denied', 'rate_limited', 'webhook_signature_invalid',
                    'mfa_failure', 'job_failed',
                    'checkout_created', 'payment_confirmed', 'duplicate_payment',
                    'refund_requested', 'refund_done', 'refund_failed',
                    'manual_payment_confirmed', 'operator_alert', 'personal_data_purged',
                    'reconciliation_mismatch'));

-- ---------------------------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------------------------
create table if not exists public.orders (
  id                   uuid primary key,
  listing_id           uuid not null,
  artist_id            uuid not null,
  status               text not null
                       check (status in ('pendiente_pago', 'pagado', 'expirado', 'cancelado',
                                         'incidencia', 'reembolsado',
                                         -- estados que anaden U4 a U6
                                         'borrador_creado', 'etiqueta_lista', 'en_transito',
                                         'entregado', 'liquidado', 'error_borrador')),
  version              integer not null default 1 check (version >= 1),
  payment_mode         text not null check (payment_mode in ('stripe', 'manual')),
  snapshot             jsonb not null,
  sender_address       jsonb not null,
  buyer                jsonb,            -- dato personal; se vacia al purgar
  destination          jsonb,            -- dato personal; se vacia al purgar
  effective_modality   text not null check (effective_modality in ('punto', 'recogida')),
  alternative_accepted boolean not null default false,
  work_price_cents     integer not null check (work_price_cents between 100 and 100000),
  shipping_cents       integer not null check (shipping_cents between 1 and 10000),
  total_cents          integer not null,
  commission_cents     integer not null default 0 check (commission_cents = 0),
  quote                jsonb not null,
  consent              jsonb not null,
  checkout_session_id  text unique,
  payment_intent_id    text,
  reservation_id       uuid,
  tracking_nonce       text not null check (char_length(tracking_nonce) between 16 and 64),
  tracking_hash        text not null unique check (char_length(tracking_hash) = 64),
  token_key_id         text not null check (char_length(token_key_id) = 8),  -- huella del secreto
  resume_hash          text unique check (resume_hash is null or char_length(resume_hash) = 64),
  resume_expires_at    timestamptz,
  submission_key       text not null unique check (char_length(submission_key) between 16 and 64),
  expires_at           timestamptz not null,
  refund_status        text not null default 'ninguno'
                       check (refund_status in ('ninguno', 'pendiente', 'hecho', 'fallido')),
  refund_reason        text check (refund_reason is null or char_length(refund_reason) <= 60),
  refund_id            text,
  personal_purged_at   timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (listing_id, artist_id) references public.listings (id, artist_id),
  check (total_cents = work_price_cents + shipping_cents),
  check ((personal_purged_at is null) or (buyer is null and destination is null))
);

-- BR3-CC3: como maximo un pedido pagado (o posterior) por enlace.
create unique index if not exists orders_one_paid_per_listing_idx
  on public.orders (listing_id)
  where status not in ('pendiente_pago', 'expirado', 'cancelado', 'incidencia', 'reembolsado');

create index if not exists orders_pending_expiry_idx
  on public.orders (status, expires_at)
  where status = 'pendiente_pago';
create index if not exists orders_artist_created_idx
  on public.orders (artist_id, created_at desc);
create index if not exists orders_listing_idx on public.orders (listing_id);
create index if not exists orders_purge_idx
  on public.orders (status, updated_at)
  where personal_purged_at is null and status in ('expirado', 'cancelado');

alter table public.orders enable row level security;
revoke all on public.orders from anon, authenticated;
grant select, insert, update on public.orders to marketlink_app;  -- sin DELETE

drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id());

-- Las compras las inicia la compradora (sin sesion): solo el contexto del sistema escribe.
drop policy if exists orders_insert on public.orders;
create policy orders_insert on public.orders for insert to marketlink_app
  with check (public.app_is_system());

drop policy if exists orders_update on public.orders;
create policy orders_update on public.orders for update to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- order_events: solo insercion, sin datos personales
-- ---------------------------------------------------------------------------------------------
create table if not exists public.order_events (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id),
  artist_id     uuid not null,
  at            timestamptz not null,
  actor         text not null check (actor in ('comprador', 'artista', 'sistema', 'operador', 'stripe')),
  kind          text not null
                check (kind in ('creado', 'pago_iniciado', 'pago_confirmado', 'sesion_expirada',
                                'cancelado_por_comprador', 'reserva_liberada', 'obra_vendida',
                                'doble_pago_detectado', 'reembolso_solicitado', 'reembolso_hecho',
                                'reembolso_fallido', 'cobro_manual_confirmado',
                                'datos_purgados')),
  from_status   text not null,
  to_status     text not null,
  reason_code   text check (reason_code is null or char_length(reason_code) <= 60),
  external_ref  text check (external_ref is null or char_length(external_ref) <= 120)
);

create index if not exists order_events_order_idx on public.order_events (order_id, at);

alter table public.order_events enable row level security;
revoke all on public.order_events from anon, authenticated, marketlink_app;
grant select, insert on public.order_events to marketlink_app;  -- ni UPDATE ni DELETE

drop policy if exists order_events_read on public.order_events;
create policy order_events_read on public.order_events for select to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id());

drop policy if exists order_events_insert on public.order_events;
create policy order_events_insert on public.order_events for insert to marketlink_app
  with check (public.app_is_system());
