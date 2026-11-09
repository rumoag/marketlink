-- U1 Fundacion: cola de trabajos (EN-10, BR-J1 a BR-J9). Aditiva.

create table if not exists public.jobs (
  id           uuid primary key default gen_random_uuid(),
  type         text not null check (char_length(type) between 1 and 100),
  payload      jsonb not null default '{}'::jsonb,
  dedupe_key   text check (dedupe_key is null or char_length(dedupe_key) between 1 and 200),
  status       text not null default 'pending'
               check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts     integer not null default 0 check (attempts between 0 and 6),
  run_at       timestamptz not null default now(),
  lease_until  timestamptz,
  last_error   text check (last_error is null or char_length(last_error) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz
);

-- BR-J7: como maximo un trabajo no terminal por dedupe_key (los NULL no entran en conflicto).
create unique index if not exists jobs_dedupe_active_idx
  on public.jobs (dedupe_key)
  where status in ('pending', 'running');

-- Reclamo: trabajos listos por orden de ejecucion.
create index if not exists jobs_ready_idx
  on public.jobs (run_at, created_at)
  where status = 'pending';

-- Recuperacion: bloqueos vencidos.
create index if not exists jobs_lease_idx
  on public.jobs (lease_until)
  where status = 'running';

-- SECURITY-08: denegar por defecto. Sin politicas para anon ni authenticated.
alter table public.jobs enable row level security;

revoke all on public.jobs from anon, authenticated;
grant select, insert, update, delete on public.jobs to marketlink_app;

drop policy if exists jobs_app_all on public.jobs;
create policy jobs_app_all on public.jobs
  for all to marketlink_app using (true) with check (true);
