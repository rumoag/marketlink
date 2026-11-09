-- U2 Artistas y enlaces: cuentas, direccion, cobros, enlaces, fotos, subidas pendientes,
-- reservas y tamanos. Migracion aditiva y compatible hacia atras.
--
-- Aislamiento por artista (EN-03, SECURITY-08): las politicas RLS leen dos ajustes de la
-- transaccion que fija la aplicacion con SET LOCAL:
--   app.artist_id = '<uuid>'   -> solo ve y escribe filas de ese artista
--   app.system    = 'on'       -> contexto del sistema (webhooks, trabajos, vista publica)
-- Sin ajustes no se ve ninguna fila (denegar por defecto).

create or replace function public.app_artist_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.artist_id', true), '')::uuid $$;

create or replace function public.app_is_system() returns boolean
language sql stable
as $$ select coalesce(current_setting('app.system', true), '') = 'on' $$;

grant execute on function public.app_artist_id() to marketlink_app;
grant execute on function public.app_is_system() to marketlink_app;

-- ---------------------------------------------------------------------------------------------
-- artists
-- ---------------------------------------------------------------------------------------------
create table if not exists public.artists (
  id             uuid primary key,  -- identidad del proveedor de autenticacion
  email          text not null unique check (email = lower(email) and char_length(email) <= 254),
  artistic_name  text check (artistic_name is null or char_length(artistic_name) between 2 and 60),
  instagram      text check (instagram is null or instagram ~ '^[a-z0-9._]{1,30}$'),
  phone          text check (phone is null or phone ~ '^\+34[6-9][0-9]{8}$'),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.artists enable row level security;
revoke all on public.artists from anon, authenticated;
grant select, insert, update on public.artists to marketlink_app;

drop policy if exists artists_scope on public.artists;
create policy artists_scope on public.artists for all to marketlink_app
  using (public.app_is_system() or id = public.app_artist_id())
  with check (public.app_is_system() or id = public.app_artist_id());

-- ---------------------------------------------------------------------------------------------
-- sender_addresses (dato personal: nunca en URLs ni logs)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.sender_addresses (
  artist_id    uuid primary key references public.artists (id),
  street       text not null check (char_length(street) between 2 and 120),
  number       text not null check (char_length(number) between 1 and 10),
  floor_door   text not null default '' check (char_length(floor_door) <= 20),
  postal_code  text not null check (
                 postal_code ~ '^(0[1-9]|[1-4][0-9]|5[0-2])[0-9]{3}$'
                 and left(postal_code, 2) not in ('07', '35', '38', '51', '52')),
  city         text not null check (char_length(city) between 2 and 60),
  province     text not null check (char_length(province) between 2 and 40),
  phone        text not null check (phone ~ '^\+34[6-9][0-9]{8}$'),
  country      text not null default 'ES' check (country = 'ES'),
  updated_at   timestamptz not null default now()
);

alter table public.sender_addresses enable row level security;
revoke all on public.sender_addresses from anon, authenticated;
grant select, insert, update on public.sender_addresses to marketlink_app;

drop policy if exists sender_addresses_scope on public.sender_addresses;
create policy sender_addresses_scope on public.sender_addresses for all to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id())
  with check (public.app_is_system() or artist_id = public.app_artist_id());

-- ---------------------------------------------------------------------------------------------
-- payout_accounts (provider_account_id solo lo usa el servidor)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.payout_accounts (
  artist_id           uuid primary key references public.artists (id),
  provider_account_id text unique,
  status              text not null default 'sin_iniciar'
                      check (status in ('sin_iniciar', 'onboarding_pendiente', 'activo', 'restringido')),
  requirements_hint   text
                      check (requirements_hint is null
                             or requirements_hint in ('info_pendiente', 'verificacion_pendiente', 'deshabilitada')),
  last_event_at       timestamptz,
  updated_at          timestamptz not null default now()
);

alter table public.payout_accounts enable row level security;
revoke all on public.payout_accounts from anon, authenticated;
grant select, insert, update on public.payout_accounts to marketlink_app;

drop policy if exists payout_accounts_scope on public.payout_accounts;
create policy payout_accounts_scope on public.payout_accounts for all to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id())
  with check (public.app_is_system() or artist_id = public.app_artist_id());

-- ---------------------------------------------------------------------------------------------
-- listings
-- ---------------------------------------------------------------------------------------------
create table if not exists public.listings (
  id                   uuid primary key default gen_random_uuid(),
  artist_id            uuid not null references public.artists (id),
  slug                 text not null unique check (slug ~ '^[a-hjkmnp-z2-9]{8}$'),
  title                text not null check (char_length(title) between 3 and 80),
  description          text not null default '' check (char_length(description) <= 1000),
  price_cents          integer not null check (price_cents between 100 and 100000),
  declared_value_cents integer not null check (declared_value_cents between 100 and 100000),
  fragile              boolean not null default false,
  size                 text not null check (size in ('S', 'M', 'L')),
  modality             text not null check (modality in ('punto', 'recogida')),
  status               text not null default 'activo' check (status in ('activo', 'pausado', 'vendido')),
  paused_reason        text check (paused_reason is null or paused_reason in ('artista', 'cobros_restringidos')),
  order_id             uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  sold_at              timestamptz,
  unique (id, artist_id),
  check ((status = 'pausado') = (paused_reason is not null)),
  check ((status = 'vendido') = (sold_at is not null))
);

create index if not exists listings_artist_status_idx on public.listings (artist_id, status);

alter table public.listings enable row level security;
revoke all on public.listings from anon, authenticated;
grant select, insert, update on public.listings to marketlink_app;  -- sin DELETE: no hay borrado en el v0

drop policy if exists listings_scope on public.listings;
create policy listings_scope on public.listings for all to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id())
  with check (public.app_is_system() or artist_id = public.app_artist_id());

-- ---------------------------------------------------------------------------------------------
-- listing_photos
-- ---------------------------------------------------------------------------------------------
create table if not exists public.listing_photos (
  id               uuid primary key default gen_random_uuid(),
  listing_id       uuid not null,
  artist_id        uuid not null,
  position         smallint not null check (position between 1 and 3),
  storage_key_full  text not null unique,
  storage_key_thumb text not null unique,
  width            integer not null check (width > 0),
  height           integer not null check (height > 0),
  bytes            integer not null check (bytes > 0),
  created_at       timestamptz not null default now(),
  foreign key (listing_id, artist_id) references public.listings (id, artist_id),
  -- Diferible: permite compactar posiciones dentro de una transaccion.
  constraint listing_photos_position_unique unique (listing_id, position) deferrable initially deferred
);

alter table public.listing_photos enable row level security;
revoke all on public.listing_photos from anon, authenticated;
grant select, insert, update, delete on public.listing_photos to marketlink_app;

drop policy if exists listing_photos_scope on public.listing_photos;
create policy listing_photos_scope on public.listing_photos for all to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id())
  with check (public.app_is_system() or artist_id = public.app_artist_id());

-- ---------------------------------------------------------------------------------------------
-- photo_uploads: subidas ya procesadas que aun no pertenecen a ningun enlace (P2-FOT-1)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.photo_uploads (
  id                uuid primary key default gen_random_uuid(),
  artist_id         uuid not null references public.artists (id),
  storage_key_full  text not null unique,
  storage_key_thumb text not null unique,
  width             integer not null check (width > 0),
  height            integer not null check (height > 0),
  bytes             integer not null check (bytes > 0),
  status            text not null default 'pendiente' check (status in ('pendiente', 'consumida')),
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  consumed_at       timestamptz,
  check ((status = 'consumida') = (consumed_at is not null))
);

create index if not exists photo_uploads_artist_idx
  on public.photo_uploads (artist_id, status, expires_at);

alter table public.photo_uploads enable row level security;
revoke all on public.photo_uploads from anon, authenticated;
grant select, insert, update, delete on public.photo_uploads to marketlink_app;

drop policy if exists photo_uploads_scope on public.photo_uploads;
create policy photo_uploads_scope on public.photo_uploads for all to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id())
  with check (public.app_is_system() or artist_id = public.app_artist_id());

-- ---------------------------------------------------------------------------------------------
-- reservations: las crea el comprador (U3), por eso solo el sistema escribe
-- ---------------------------------------------------------------------------------------------
create table if not exists public.reservations (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null,
  artist_id   uuid not null,
  status      text not null default 'activa'
              check (status in ('activa', 'liberada', 'consumida', 'expirada')),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (listing_id, artist_id) references public.listings (id, artist_id)
);

-- BR2-RS1/RS2: como maximo una reserva activa por enlace (segunda barrera tras el bloqueo de fila).
create unique index if not exists reservations_one_active_idx
  on public.reservations (listing_id)
  where status = 'activa';

alter table public.reservations enable row level security;
revoke all on public.reservations from anon, authenticated;
grant select, insert, update on public.reservations to marketlink_app;

drop policy if exists reservations_read on public.reservations;
create policy reservations_read on public.reservations for select to marketlink_app
  using (public.app_is_system() or artist_id = public.app_artist_id());

drop policy if exists reservations_write on public.reservations;
create policy reservations_write on public.reservations for insert to marketlink_app
  with check (public.app_is_system());

drop policy if exists reservations_update on public.reservations;
create policy reservations_update on public.reservations for update to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());

-- ---------------------------------------------------------------------------------------------
-- size_presets: lectura para todos los contextos; escritura solo del sistema (operador, U6)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.size_presets (
  size          text primary key check (size in ('S', 'M', 'L')),
  length_cm     integer not null check (length_cm > 0),
  width_cm      integer not null check (width_cm > 0),
  height_cm     integer not null check (height_cm > 0),
  weight_kg     numeric(5, 2) not null check (weight_kg > 0),
  example_label text not null check (char_length(example_label) between 1 and 80),
  updated_at    timestamptz not null default now()
);

insert into public.size_presets (size, length_cm, width_cm, height_cm, weight_kg, example_label)
values
  ('S', 30, 25, 5, 1.00, 'Dibujo, grabado o lamina pequena'),
  ('M', 50, 40, 10, 2.00, 'Lienzo o lamina mediana'),
  ('L', 80, 60, 10, 5.00, 'Lienzo grande')
on conflict (size) do nothing;

alter table public.size_presets enable row level security;
revoke all on public.size_presets from anon, authenticated;
grant select, update on public.size_presets to marketlink_app;

drop policy if exists size_presets_read on public.size_presets;
create policy size_presets_read on public.size_presets for select to marketlink_app using (true);

drop policy if exists size_presets_write on public.size_presets;
create policy size_presets_write on public.size_presets for update to marketlink_app
  using (public.app_is_system()) with check (public.app_is_system());
