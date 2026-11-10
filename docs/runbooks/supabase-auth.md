# Runbook: configurar Supabase Auth y el correo de acceso

Se hace una vez por proyecto de Supabase (sandbox y, antes de M2, producción). Estado: **verificado en sandbox (2026-11-10)**: alta de una artista nueva, correo de acceso por Resend, pantalla intermedia y entrada a `/artista`. Para producción hay que repetirlo con el dominio y el SMTP definitivos. Los valores marcados «a verificar» dependen del plan del proveedor.

## 1. Ajustes de Auth

| Ajuste                                 | Valor                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Registro por email                     | Activado (registro abierto)                                                                                               |
| Confirmación por enlace de un solo uso | Activada                                                                                                                  |
| Caducidad del enlace (OTP)             | 900 s (15 minutos); si el plan no permite tanto, el mínimo permitido (a verificar)                                        |
| `Site URL`                             | La URL estable del entorno (sandbox: la de Vercel; producción: el dominio)                                                |
| URLs de redirección permitidas         | Solo la `Site URL` y, en desarrollo, `http://localhost:3000`. **Sin comodines**                                           |
| Caducidad del token de acceso          | Lo más corta que permita el plan; objetivo 900 s (a verificar)                                                            |
| Rotación del token de refresco         | Activada                                                                                                                  |
| Límites de sesión del proveedor        | No se usan: la aplicación aplica 7 y 30 días                                                                              |
| Claves de firma del JWT                | Asimétricas (así `getClaims` verifica sin red); si el proyecto usa secreto compartido, funciona pero consulta al servidor |

## 2. Plantilla del correo «Magic Link» (y también «Confirm sign up»)

**Supabase solo deja editar las plantillas si hay SMTP propio** (apartado 3, hay que hacerlo antes). Y la plantilla hay que ponerla en **dos sitios**: una cuenta nueva o sin confirmar recibe «Confirm sign up», y una ya confirmada recibe «Magic link». Con solo una de las dos, el primer correo de una artista nueva llega con el enlace por defecto de Supabase, que no sirve con nuestra pantalla de entrada. Ambas usan el mismo cuerpo, y la aplicación verifica siempre con `type: 'email'`.

Asunto: `Tu enlace para entrar`. Cuerpo (texto sencillo en español, sin imágenes remotas):

```
Hola,

Pulsa el botón para entrar. El enlace caduca en 15 minutos y solo funciona una vez.

{{ .SiteURL }}/acceso/confirmar?token_hash={{ .TokenHash }}

Si no lo has pedido tú, ignora este correo.
```

El enlace **no** usa `{{ .ConfirmationURL }}`: tiene que apuntar a la página intermedia para que el token no se consuma al abrirlo.

## 3. SMTP de Resend

1. Crear la clave de envío en Resend (permiso solo de envío).
2. En Supabase → Auth → SMTP: servidor `smtp.resend.com`, puerto 465 o 587, usuario `resend`, contraseña = la clave de envío.
3. Remitente: `acceso@<dominio>` (con el dominio verificado: SPF, DKIM y DMARC). **Sin dominio verificado, Resend solo entrega al titular de la cuenta.**
4. Revisar el límite de correos por hora de Supabase Auth y subirlo si hace falta (los nuestros se aplican antes: 5 por email y 20 por IP cada hora).

## 4. Rol de la aplicación y variables

Ver `rotacion-secretos.md` (alta del rol `marketlink_app`) y `.env.example`. Variables de U2: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_COOKIE_SECRET`.

## 5. Comprobación manual obligatoria (una vez por entorno)

1. Pide un enlace desde `/acceso` con un correo real.
2. Comprueba que el correo llega, que el botón apunta a `/acceso/confirmar` de la URL estable y que **abrir el enlace no inicia sesión**.
3. Pulsa «Entrar»: debes llegar a `/artista`.
4. Reutiliza el mismo enlace: debe mostrar «Este enlace ya no es válido».
5. Cierra sesión y comprueba que `/artista` redirige a `/acceso`.
6. Anota la fecha y el resultado en `docs/quotas.md` (límites reales verificados).

## U6: enlace del operador y plantilla

La aplicación pide ahora siempre el enlace con `emailRedirectTo` (artistas: `/acceso/confirmar`; operador: `/operador/acceso/confirmar`). La plantilla del correo de acceso debe usar `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email` y ambas URL deben estar en la lista de redirecciones permitidas. Tras cambiarla, comprueba que el botón del correo de una artista sigue apuntando a `/acceso/confirmar` y que **abrir el enlace no inicia sesión** (solo el botón «Entrar»).
