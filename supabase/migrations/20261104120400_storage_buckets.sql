-- U1 Fundacion: buckets privados (EN-14, SECURITY-01). Aditiva.
-- Solo aplica en Supabase (esquema `storage`). Sin politicas para anon ni authenticated:
-- unicamente el servidor, con la clave de servicio, accede a los objetos (URLs firmadas).

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values
      ('listing-images', 'listing-images', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp']),
      ('labels', 'labels', false, 5242880, array['application/pdf'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end
$$;
