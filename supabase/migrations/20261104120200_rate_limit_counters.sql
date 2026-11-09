-- U1 Fundacion: contadores de limitacion de tasa (EN-02, BR-L1 a BR-L5). Aditiva.
-- subject_hash es un HMAC con sal secreta: nunca se guarda la IP ni el email en claro (BR-L3).

create table if not exists public.rate_limit_counters (
  rule         text not null check (char_length(rule) between 1 and 64),
  subject_hash text not null check (char_length(subject_hash) between 1 and 128),
  window_start timestamptz not null,
  count        integer not null default 0 check (count >= 0),
  primary key (rule, subject_hash, window_start)
);

-- Limpieza diaria de ventanas antiguas.
create index if not exists rate_limit_counters_window_idx
  on public.rate_limit_counters (window_start);

alter table public.rate_limit_counters enable row level security;

revoke all on public.rate_limit_counters from anon, authenticated;
grant select, insert, update, delete on public.rate_limit_counters to marketlink_app;

drop policy if exists rate_limit_counters_app_all on public.rate_limit_counters;
create policy rate_limit_counters_app_all on public.rate_limit_counters
  for all to marketlink_app using (true) with check (true);
