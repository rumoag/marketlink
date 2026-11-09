# Runbook: acceso del operador

## Alta (una vez)

1. Genera el secreto en tu equipo (no llama a ningún servicio):

   ```bash
   node scripts/ops/new-operator-totp.mjs tu@correo.com
   ```

2. Escanea la URI `otpauth://…` con tu aplicación de autenticación (o escribe el secreto a mano).
3. En Vercel (primero el entorno de pruebas) define:
   - `OPERATOR_EMAILS=tu@correo.com`
   - `OPERATOR_TOTP_SECRETS=tu@correo.com:SECRETO`
   - `OPERATOR_SESSION_SECRET=` (32 caracteres o más, aleatorios)
4. En Supabase Auth añade `https://<dominio>/operador/acceso/confirmar` a las URL de redirección permitidas y cambia la plantilla del correo de acceso a:

   ```text
   {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email
   ```

   (la aplicación envía siempre `emailRedirectTo`, también para las artistas: `/acceso/confirmar`).

5. Redespliega y entra en `/operador/acceso`.

## Entrar

Escribe tu correo → abre el enlace del correo → pulsa **Entrar** → escribe el código de 6 dígitos. La sesión caduca a los 60 minutos de inactividad y a las 8 horas. Liberar y reembolsar piden además un código nuevo: espera al siguiente (30 s) si el anterior ya se usó.

## He perdido el móvil o cambio de teléfono

No hay códigos de recuperación. Con acceso a Vercel: genera un secreto nuevo con el script, actualiza `OPERATOR_TOTP_SECRETS`, rota `OPERATOR_SESSION_SECRET` y redespliega.

## Sospecho de un acceso ajeno

Rota `OPERATOR_SESSION_SECRET` (cierra todas las sesiones al instante) y el secreto TOTP, y revisa la auditoría (`operator_login`, `operator_locked`, `mfa_failure`, `operator_view_order`, `operator_refund`, `operator_release`). Cada acceso correcto te envía un correo «Acceso al panel»; un bloqueo envía otro y genera la alerta `acceso_operador_bloqueado`.

## Cerrar el panel sin desplegar

Vacía `OPERATOR_EMAILS` (todas las sesiones caducan en la siguiente petición) o rota `OPERATOR_SESSION_SECRET`.

## Comprobación obligatoria (la haces tú)

**Fase 1 (sandbox):** alta con el script y escaneo → pedir el enlace con tu email → confirmar → código TOTP → acción de prueba (nota o reintentar un borrador) → caducidad por inactividad → pedir el enlace con un email **no** autorizado: misma respuesta y no llega nada.

**Fase 2 (antes de M2, producción):** el mismo recorrido con las claves reales → llega el aviso «Acceso al panel» → provoca un bloqueo con 5 códigos erróneos y verifica la alerta y el correo → una liberación o un reembolso de prueba con código. Anota la fecha y el resultado aquí.

## Packlink PRO

El panel enlaza a la lista de envíos (`https://pro.packlink.es/private/shipments`) y muestra la referencia con la que buscar el borrador. Si en la comprobación aparece una dirección profunda estable, se cambia en `packlinkShipmentsUrl()` (`src/modules/operator/domain/stuck.ts`).
