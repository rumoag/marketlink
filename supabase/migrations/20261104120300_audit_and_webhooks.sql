-- U1 Fundacion: auditoria de solo insercion (SECURITY-13/14) y recepcion idempotente de webhooks.
-- Aditiva.

create table if not exists public.audit_events (
  id             uuid primary key default gen_random_uuid(),
  occurred_at    timestamptz not null,
  actor_type     text not null
                 check (actor_type in ('artist', 'operator', 'buyer', 'system', 'anonymous')),
  actor_id       text,
  action         text not null
                 check (action in ('auth_failure', 'authz_denied', 'rate_limited',
                                   'webhook_signature_invalid', 'mfa_failure', 'job_failed')),
  resource_type  text,
  resource_id    text,
  outcome        text not null check (outcome in ('success', 'denied', 'failure')),
  correlation_id text not null,
  details        jsonb not null default '{}'::jsonb
);

create index if not exists audit_events_occurred_idx on public.audit_events (occurred_at desc);
create index if not exists audit_events_action_idx on public.audit_events (action, occurred_at desc);

alter table public.audit_events enable row level security;

-- Solo se anade y se lee: el rol de la aplicacion no puede modificar ni borrar (P-SEG-7).
revoke all on public.audit_events from anon, authenticated, marketlink_app;
grant select, insert on public.audit_events to marketlink_app;

drop policy if exists audit_events_app_insert on public.audit_events;
create policy audit_events_app_insert on public.audit_events
  for insert to marketlink_app with check (true);

drop policy if exists audit_events_app_select on public.audit_events;
create policy audit_events_app_select on public.audit_events
  for select to marketlink_app using (true);

-- Recepcion de webhooks (EN-06): la restriccion unica da idempotencia (provider, event_id).
create table if not exists public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null check (provider in ('stripe', 'packlink', 'resend')),
  event_id     text not null check (char_length(event_id) between 1 and 255),
  event_type   text not null check (char_length(event_type) between 1 and 255),
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'received' check (status in ('received', 'processed', 'failed')),
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);

create index if not exists webhook_events_status_idx
  on public.webhook_events (status, received_at)
  where status <> 'processed';

alter table public.webhook_events enable row level security;

revoke all on public.webhook_events from anon, authenticated;
grant select, insert, update on public.webhook_events to marketlink_app;

drop policy if exists webhook_events_app_all on public.webhook_events;
create policy webhook_events_app_all on public.webhook_events
  for all to marketlink_app using (true) with check (true);
