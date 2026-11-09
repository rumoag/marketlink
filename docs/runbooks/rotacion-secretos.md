# Runbook: secretos y rol de la aplicación

Los secretos viven solo en variables de entorno de Vercel (por entorno), secretos de GitHub (pipeline) y Supabase Vault (`pg_cron`). **Nunca** en el repositorio, el chat ni los logs. Las variables de producción no se definen en el ámbito de vista previa de Vercel.

## Inventario

| Secreto                                              | Dónde                                              | Para qué                        | Rotación                                           |
| ---------------------------------------------------- | -------------------------------------------------- | ------------------------------- | -------------------------------------------------- |
| `DATABASE_URL` (rol `marketlink_app`)                | Vercel                                             | La aplicación                   | Al sospechar fuga y cada 12 meses                  |
| `SUPABASE_DB_URL` (propietario)                      | Secretos de GitHub, _environment_                  | Solo migraciones                | Idem                                               |
| `BACKUP_DATABASE_URL` / `BACKUP_PASSPHRASE`          | Secretos de GitHub, _environment_ production       | Copia diaria cifrada            | Idem; guarda la frase en tu gestor de contraseñas  |
| `INTERNAL_JOBS_SECRET`                               | Vercel y Supabase Vault (`marketlink_jobs_secret`) | Endpoint de trabajos            | Cada 12 meses                                      |
| `RATE_LIMIT_SALT`                                    | Vercel                                             | Resumen de IP y email           | Solo si se filtra (reinicia los contadores)        |
| `MONITOR_SECRET`                                     | Vercel y el monitor externo                        | `/api/health/deep`              | Cada 12 meses                                      |
| `SUPABASE_SERVICE_ROLE_KEY`                          | Vercel (solo servidor)                             | Storage y revocar sesiones      | Al sospechar fuga y cada 12 meses                  |
| `SESSION_COOKIE_SECRET`                              | Vercel                                             | Firma de la cookie de actividad | Cada 12 meses (cierra todas las sesiones)          |
| `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET` | Vercel                                             | Cuentas de artistas y webhook   | Según Stripe; ver `stripe-connect.md`              |
| Credencial SMTP de Resend                            | Panel de Supabase (Auth → SMTP)                    | Correo del enlace de acceso     | Cada 12 meses; ver `supabase-auth.md`              |
| `STRIPE_PLATFORM_WEBHOOK_SECRET`                     | Vercel                                             | Webhook de pagos (U3)           | Según Stripe; ver `stripe-checkout.md`             |
| `PACKLINK_WEBHOOK_SECRET`                            | Vercel                                             | Webhook de envíos (U4)          | Según Packlink; ver `packlink-envios.md`           |
| `RESEND_API_KEY`                                     | Vercel                                             | Correo transaccional (U4)       | Cada 12 meses; ver `resend.md`                     |
| `TRACKING_TOKEN_SECRET` (+ `_PREVIOUS`)              | Vercel                                             | Token de seguimiento (U3)       | Cada 12 meses; el anterior se retira a los 90 días |
| Claves de Packlink y Resend (envío)                  | Vercel                                             | Proveedores (cotización en U3)  | Según el proveedor                                 |

Genera valores aleatorios de 32 o más caracteres, por ejemplo `openssl rand -base64 36`.

## Alta del rol de la aplicación (una vez por proyecto de Supabase)

Las migraciones crean `marketlink_app` sin acceso. Habilítalo desde el editor SQL de Supabase (no desde el repositorio):

```sql
ALTER ROLE marketlink_app LOGIN PASSWORD '<valor-aleatorio>';
```

Construye `DATABASE_URL` con el agrupador de conexiones en modo transacción (puerto 6543), usuario `marketlink_app.<ref-del-proyecto>`, y guárdala en Vercel.

## Secretos de `pg_cron` (solo si las extensiones están disponibles)

```sql
select vault.create_secret('https://<tu-dominio>', 'marketlink_app_url');
select vault.create_secret('<INTERNAL_JOBS_SECRET>', 'marketlink_jobs_secret');
```

## Rotar un secreto

1. Genera el valor nuevo.
2. Actualízalo primero donde se **comprueba** (si el cliente y el servidor lo comparten, cambia ambos en la misma ventana).
3. Redespliega en Vercel para que lea las variables.
4. Comprueba la salud profunda y que el pipeline sigue funcionando.
5. Revoca el valor anterior (para una contraseña de base de datos, `ALTER ROLE … PASSWORD`).
6. Anota la fecha de la rotación.

## Si se filtra un secreto

Rótalo de inmediato (sin esperar a la ventana), revisa `audit_events` y los logs de la franja afectada y, si era una clave de producción de un proveedor, revócala en el panel del proveedor.

## Rotar `TRACKING_TOKEN_SECRET`

1. Pasa el valor actual a `TRACKING_TOKEN_SECRET_PREVIOUS` y pon un valor nuevo en `TRACKING_TOKEN_SECRET`.
2. Redespliega. Los enlaces ya entregados siguen funcionando (la búsqueda es por resumen) y se pueden volver a mostrar con el secreto con el que se emitieron.
3. A los 90 días, borra `TRACKING_TOKEN_SECRET_PREVIOUS`. Si se filtra el secreto, rótalo sin esperar.

## U5: sin secretos nuevos

El dinero reutiliza `STRIPE_SECRET_KEY` (transferencias, pagos a banco y reembolsos) y `STRIPE_PLATFORM_WEBHOOK_SECRET`. Al rotar `STRIPE_SECRET_KEY`, haz una liquidación y una retirada de prueba en sandbox antes de producción.

## U6: secretos del operador

- **`OPERATOR_SESSION_SECRET`:** rotarlo cierra todas las sesiones de operador de inmediato.
- **`OPERATOR_TOTP_SECRETS`:** el secreto de cada operador se cambia con `scripts/ops/new-operator-totp.mjs` y se actualiza en Vercel; hay que volver a escanear la URI. Ver `operador-acceso.md`.
