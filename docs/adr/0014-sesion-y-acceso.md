# ADR 0014: Acceso con enlace de un solo uso y política de sesión

- Estado: aceptado
- Fecha: 2026-11-05
- Unidad: U2 Artistas y enlaces

## Contexto

El acceso es sin contraseña. Muchos gestores de correo abren los enlaces para analizarlos y gastan los de un solo uso. Los límites de sesión del proveedor (inactividad y duración máxima) pueden ser de pago, y la validación de cada petición no debe superar los 100 ms de sobrecarga.

## Decisión

1. **El enlace del correo no inicia sesión.** Lleva a `/acceso/confirmar`, una página nuestra con un botón «Entrar»; solo al pulsarlo se consume el token (`POST` con el token en el cuerpo). Un escáner de correo que abra el enlace no lo gasta. Caduca a los 15 minutos (ajuste del proveedor).
2. **Respuesta uniforme.** Pedir un enlace responde siempre lo mismo exista o no la cuenta y aunque el correo falle; los límites por email (5/h) y por IP (20/h) fallan cerrados.
3. **Tres cookies propias**, todas `HttpOnly` y `SameSite=Lax` (y `Secure` en HTTPS): `ml_at` (token de acceso), `ml_rt` (token de refresco) y `ml_act`, una cookie de actividad **firmada con HMAC** con `createdAt` y `lastActivityAt`.
4. **Vigencia aplicada por la aplicación**: 7 días de inactividad y 30 como máximo, con una función pura (`isSessionValid`). No dependemos de los límites de sesión del proveedor.
5. **Verificación local del token** (`getClaims`; con claves asimétricas no hay llamada de red). Si caducó, el proxy lo renueva con el token de refresco rotatorio y devuelve las cookies nuevas. La actividad se renueva como mucho cada 5 minutos.
6. **Identidad hacia la aplicación**: el proxy borra siempre las cabeceras `x-ml-*` que envíe el cliente y fija `x-ml-artist-id` solo tras comprobar la sesión. Páginas y rutas leen esa cabecera.
7. **Cerrar sesión** revoca la sesión en el proveedor y borra las tres cookies.
8. **Navegación sin sesión**: un navegador que pide una página privada va a `/acceso?caducada=1`; la API recibe 401 en JSON.

## Alternativas descartadas

- `@supabase/ssr` para gestionar las cookies: no encaja con la cookie de actividad y la política de 7 y 30 días y añadía una dependencia sin uso.
- Validar contra el servicio de autenticación en cada petición (50–150 ms por petición) o una tabla propia de sesiones (una consulta más): se reservan para M2 si se decide que hace falta revocación inmediata; el cambio queda aislado en `SessionResolverImpl`.

## Consecuencias

- Un token de acceso robado vale como máximo hasta que caduca (objetivo de 15 minutos, a verificar en el plan del proveedor); un token de refresco robado es rotatorio y se revoca al cerrar sesión.
- La cookie de actividad manipulada o firmada con otro secreto no da acceso (probado).
- `SESSION_COOKIE_SECRET` es un secreto más a rotar: rotarlo cierra todas las sesiones.
