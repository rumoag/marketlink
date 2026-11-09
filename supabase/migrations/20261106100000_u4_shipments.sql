-- U4 Envio y seguimiento: envios, bandeja de notificaciones, coste y margen en pedidos, eventos y
-- acciones de auditoria nuevos, limite del bucket de etiquetas. Migracion aditiva.
--
-- Datos personales: ni shipments ni notifications guardan nombre, email, telefono ni direccion
-- de nadie. Las notificaciones resuelven el destinatario al enviar.

-- ---------------------------------------------------------------------------------------------
-- orders: coste real de la etiqueta y margen del envio (pueden ser negativos)
-- ---------------------------------------------------------------------------------------------
alter table public.orders
  add column if not exists label_cost_cents integer check (label_cost_cents is null or label_cost_cents >= 0),
  add column if not exists margin_cents integer;

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
                  'entregado', 'incidencia_envio', 'recogida_elegida'));

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
                    'labels_purged'));

-- ---------------------------------------------------------------------------------------------
-- shipments
-- ---------------------------------------------------------------------------------------------
create table if not exists public.shipments (
  id                         uuid primary key default gen_random_uuid(),
  order_id                   uuid not null unique references public.orders (id),
  artist_id                  uuid not null,
  status                     text not null default 'creando'
                             check (status in ('creando', 'borrador', 'etiqueta_lista',
                                               'en_transito', 'entregado')),
  incident                   text check (incident is null or incident in ('fallo_etiqueta', 'fallo_transportista')),
  failure_reason             text check (failure_reason is null or char_length(failure_reason) <= 60),
  provider_ref               text check (provider_ref is null or char_length(provider_ref) between 1 and 120),
  service_id                 text not null check (char_length(service_id) between 1 and 120),
  carrier_name               text check (carrier_name is null or char_length(carrier_name) <= 120),
  label_key                  text check (label_key is null or char_length(label_key) <= 200),
  tracking_url               text check (tracking_url is null or char_length(tracking_url) <= 500),
  tracking_code              text check (tracking_code is null or char_length(tracking_code) <= 100),
  pickup                     jsonb,
  pickup_options             jsonb,
  dropoff_points             jsonb,
  label_cost_cents           integer check (label_cost_cents is null or label_cost_cents >= 0),
  last_provider_event_at     timestamptz,
  next_poll_at               timestamptz,
  pickup_requested_at        timestamptz,
  pickup_reminded_at         timestamptz,
  pickup_operator_alerted_at timestamptz,
  pay_reminded_at            timestamptz,
  draft_created_at           timestamptz,
  delivered_at               timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create unique index if not exists shipments_provider_ref_idx
  on public.shipments (provider_ref) where provider_ref is not null;
create index if not exists shipments_poll_idx
  on public.shipments (next_poll_at) where next_poll_at is not null;
create index if not exists shipments_artist_idx on public.shipments (artist_id);

alter table public.shipments enable row level security;
revoke all on public.shipments from anon, authenticated;
grant select, insert, update on public.shipments to marketlink_app;  -- sin DELETE

drop policy if exists shipments_read on public.shipments;
create policy shipments_read on public.shipments for select to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id());

drop policy if exists shipments_insert on public.shipments;
create policy shipments_insert on public.shipments for insert to marketlink_app
  with check (public.app_is_system());

drop policy if exists shipments_update on public.shipments;
create policy shipments_update on public.shipments for update to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- notifications: bandeja de salida (se inserta con el cambio de estado, en la misma transaccion)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders (id),
  artist_id       uuid not null,
  type            text not null
                  check (type in ('pedido_nuevo_artista', 'confirmacion_compradora',
                                  'paga_envio_operador', 'elegir_recogida_artista',
                                  'recordatorio_recogida_artista', 'recogida_sin_elegir_operador',
                                  'etiqueta_lista_artista', 'en_camino_compradora',
                                  'entregado_compradora', 'entregado_artista',
                                  'incidencia_artista', 'incidencia_compradora',
                                  'incidencia_operador', 'recordatorio_pago_envio_operador')),
  recipient_role  text not null check (recipient_role in ('artista', 'compradora', 'operador')),
  status          text not null default 'pendiente' check (status in ('pendiente', 'enviada', 'fallida')),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error      text check (last_error is null or char_length(last_error) <= 60),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  unique (order_id, type)
);

create index if not exists notifications_pending_idx
  on public.notifications (next_attempt_at) where status = 'pendiente';
create index if not exists notifications_artist_idx on public.notifications (artist_id, status);

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select, insert, update, delete on public.notifications to marketlink_app;  -- DELETE: retencion

drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id());

drop policy if exists notifications_write on public.notifications;
create policy notifications_write on public.notifications for insert to marketlink_app
  with check (public.app_is_system());

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications for delete to marketlink_app
  using (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- Bucket de etiquetas: solo PDF y como maximo 2 MB (solo aplica en Supabase)
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    update storage.buckets
       set public = false,
           file_size_limit = 2097152,
           allowed_mime_types = array['application/pdf']
     where id = 'labels';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Trabajos periodicos (condicional a pg_cron, como en U1 y U3)
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('marketlink-poll-shipments', '* * * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('poll_shipments', 'poll-shipments:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
    perform cron.schedule('marketlink-dispatch-notifications', '* * * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('dispatch_notifications', 'dispatch-notifications:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
    perform cron.schedule('marketlink-remind-pickup', '*/15 * * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('remind_pickup', 'remind-pickup:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
    perform cron.schedule('marketlink-remind-pay-label', '*/15 * * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('remind_pay_label', 'remind-pay-label:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
    perform cron.schedule('marketlink-purge-labels', '30 4 * * *',
      $job$ insert into public.jobs (type, dedupe_key)
            values ('purge_labels_and_notifications', 'purge-labels:' || to_char(now(), 'YYYY-MM-DD'))
            on conflict (dedupe_key) where status in ('pending', 'running') do nothing $job$);
  end if;
end
$$;
