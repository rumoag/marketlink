-- U2: el bucket de fotos solo recibe lo que produce nuestro procesado (WebP sin metadatos, 1 MB).
-- Solo aplica en Supabase (esquema `storage`). Aditiva: ajusta un bucket que ya existe.

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    update storage.buckets
       set public = false,
           file_size_limit = 1048576,
           allowed_mime_types = array['image/webp']
     where id = 'listing-images';
  end if;
end
$$;
