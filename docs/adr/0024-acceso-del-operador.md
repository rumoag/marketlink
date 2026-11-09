# ADR 0024: Acceso del operador con TOTP propio y sesión separada de las artistas

- Estado: aceptado
- Fecha: 2026-11-08
- Unidad: U6 Panel del operador

## Decisión

1. **Lista de operadores en el entorno** (`OPERATOR_EMAILS`) y un secreto TOTP por operador (`OPERATOR_TOTP_SECRETS`, `email:SECRETO_BASE32`); el secreto de firma de la cookie es `OPERATOR_SESSION_SECRET`. La configuración rechaza el arranque en live si faltan, si un email no tiene secreto o si el secreto de sesión es débil; los errores nombran la variable, nunca el valor.
2. **TOTP RFC 6238 propio** (SHA-1, 6 dígitos, paso de 30 s, ventana ±1, comparación en tiempo constante) con `node:crypto`, verificado con los vectores oficiales. Un código no se reutiliza: el paso aceptado se fija con una sola sentencia `UPDATE … WHERE last_step < paso`. Cinco fallos en 15 minutos bloquean 15 minutos (aviso inmediato por `OperatorAlerts` y por correo); el bloqueo falla cerrado.
3. **Sesión separada:** el enlace mágico (Supabase Auth, mismo proyecto) solo sirve para obtener el email verificado; la sesión del proveedor se descarta y no se toca ninguna fila de artista. La sesión es la cookie `ml_op` (`HttpOnly`, `SameSite=Strict`, `Secure`, firmada con HMAC) con dos etapas (`pendiente_mfa`, `completa`), 60 minutos de inactividad, 8 horas absolutas y 10 minutos para la etapa pendiente. El proxy revalida en cada petición, incluida la presencia del email en la lista: quitarlo cierra la sesión.
4. **Respuesta indistinguible:** pedir el enlace hace siempre lo mismo (límite por IP → encolar → respuesta fija); un email no autorizado no se guarda en el trabajo.
5. **Acciones de dinero con código fresco:** liberar y reembolsar piden un código TOTP nuevo en el formulario, validado con la misma función (mismo contador de fallos y misma regla de no reutilización).
6. **Avisos** de acceso y de bloqueo por la cola de trabajos (`operator_notice`, con reintentos) en lugar de la tabla `notifications` (que exige artista); el bloqueo además por `OperatorAlerts`.

## Desviaciones y consecuencias

- `Referrer-Policy: same-origin` (no `no-referrer`) en `/operador/**`: con `no-referrer` el navegador envía `Origin: null` y Next.js rechaza las acciones de servidor. No se filtra nada hacia fuera.
- Recuperación: sin códigos de recuperación; se rota el secreto con `scripts/ops/new-operator-totp.mjs` (runbook `operador-acceso.md`).
- Supabase Auth: el enlace lleva `emailRedirectTo`; la plantilla del correo debe usar `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email` (ver `supabase-auth.md`).
