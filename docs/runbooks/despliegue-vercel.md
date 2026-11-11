# Runbook: desplegar en Vercel

Estado: **pendiente de ejecutar** (la base de datos de Supabase se crea después). La región de las funciones es `fra1` (`vercel.json`), cerca de Supabase en Fráncfort.

## 1. Proyecto

1. Cuenta de Vercel y la aplicación de GitHub de Vercel instalada con acceso al repositorio `rumoag/marketlink`.
2. Desde `marketlink/`: `vercel login`, `vercel link` y `vercel git connect` (o «Add New → Project» en el panel). La raíz del proyecto es la raíz del repositorio.
3. Framework: Next.js (se detecta). Versión de Node: 24.

## 2. Variables de entorno

Se definen por entorno (Preview y Production) con `vercel env add NOMBRE <entorno>`. **Nunca** en el repositorio.

| Variable                                                                                                                                 | Valor                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                                                                                                                                | `sandbox` (Preview); `live` solo en Production tras M2                                                                                                                                                                                               |
| `PRODUCT_NAME`, `LOG_LEVEL`                                                                                                              | nombre del producto y `info`                                                                                                                                                                                                                         |
| `APP_URL`                                                                                                                                | la URL pública del despliegue (sin barra final)                                                                                                                                                                                                      |
| `INTERNAL_JOBS_SECRET`, `RATE_LIMIT_SALT`, `MONITOR_SECRET`, `SESSION_COOKIE_SECRET`, `TRACKING_TOKEN_SECRET`, `OPERATOR_SESSION_SECRET` | aleatorios de 48 caracteres, distintos por entorno                                                                                                                                                                                                   |
| `DATABASE_URL`                                                                                                                           | cadena de conexión del agrupador de Supabase (rol de aplicación)                                                                                                                                                                                     |
| `DATABASE_CA_CERT`                                                                                                                       | certificado de la CA de Supabase (PEM) para verificar el TLS de la base. Supabase → Database → Settings → SSL Configuration → Download certificate. Obligatorio en `live`; en sandbox, sin él, la conexión va cifrada pero sin verificar al servidor |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`                                                                  | del proyecto de Supabase                                                                                                                                                                                                                             |
| `STRIPE_SECRET_KEY`, `STRIPE_API_VERSION`                                                                                                | `sk_test_…` en Preview; la versión de API fijada                                                                                                                                                                                                     |
| `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_PLATFORM_WEBHOOK_SECRET`                                                                        | de los destinos de eventos (`stripe-connect.md`, `stripe-checkout.md`)                                                                                                                                                                               |
| `PACKLINK_API_KEY`, `PACKLINK_WEBHOOK_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `OPERATOR_EMAIL`, `CONTACT_EMAIL`                         | de cada proveedor                                                                                                                                                                                                                                    |
| `OPERATOR_EMAILS`, `OPERATOR_TOTP_SECRETS`                                                                                               | `operador-acceso.md`                                                                                                                                                                                                                                 |
| `PAYOUT_MODE`                                                                                                                            | `manual`                                                                                                                                                                                                                                             |

`E2E_ENABLED` no se define nunca en Production (la configuración lo rechaza en `live`).

**Formato de `DATABASE_URL`:** debe empezar exactamente por `postgresql://`, sin comillas, espacios ni el nombre de la variable delante, con el usuario `marketlink_app.<id-del-proyecto>`, el puerto 6543 (Transaction pooler) y la contraseña solo con letras y números (o codificada en porcentaje). Si no, `pg` lee un servidor falso («base» u otro trozo de la cadena) y falla con `ENOTFOUND`. La configuración rechaza ahora esos valores. Supabase exige TLS: la app lo activa sola fuera de servidores locales.

## 3. Después del primer despliegue

1. Comprobar `GET <APP_URL>/api/health` (público, mínimo) y `GET /api/health/deep` con `x-monitor-secret`. Si la base falla, la respuesta incluye `databaseError` con el código y el mensaje del error (sin la cadena de conexión).
2. Crear los destinos de eventos de Stripe con la URL pública (`stripe-connect.md`, apartado 3).
3. Revisar en los registros de Vercel que las funciones corren en `fra1`.
4. La subida de fotos usa `sharp`: confirmar que `POST /api/artista/fotos` responde con una foto real (límite de 30 s).

## 3 bis. Dos cosas que hacen falta para que los pagos se procesen (verificado en sandbox, 2026-11-10)

1. **Secretos del Vault de Supabase.** El reloj de la base (`pg_cron`, cada minuto) lee la URL y el secreto de la aplicación del Vault. Sin ellos, los avisos de Stripe se guardan pero los trabajos que dejan (marcar el pedido como pagado, crear el borrador del envío…) **no se procesan** y el comprador ve «esperando el pago». En el editor SQL de Supabase:
   `select vault.create_secret('<APP_URL>', 'marketlink_app_url');` y `select vault.create_secret('<INTERNAL_JOBS_SECRET>', 'marketlink_jobs_secret');` (el mismo valor que en Vercel). Comprueba con `select jobname, schedule, active from cron.job;` (debe haber `marketlink-run-jobs`) y con `select status, left(return_message, 120) from cron.job_run_details order by start_time desc limit 5;` (estado `succeeded`).
2. **Los destinos de eventos de Stripe deben crearse en el mismo entorno que la clave de la aplicación.** Comprueba que el identificador `acct_…` de la dirección del Dashboard coincide con el de la clave (`GET /v1/account` con la clave). Si no, Stripe cobra pero no avisa a nadie. Dos pistas de que están en otro entorno: `GET /v1/webhook_endpoints` sale vacío y los eventos recientes tienen `pending_webhooks: 0`.

Con la migración `20261110100000_job_queue_hardening.sql` (ADR 0030) la cola ya no se acumula aunque el reloj no corra: hay como mucho un periódico pendiente por tipo, los eventos se reclaman antes que los periódicos y `/operador/salud` pasa a «Atención» si un trabajo listo lleva más de 5 minutos esperando. **Comprueba siempre tras desplegar** que `/api/health/deep` no trae `jobsOldestPendingSeconds` alto (más de 300 s lo pone en `degraded`). El disparo inmediato tras recibir el aviso es una mejora sobre el reloj de cada minuto.

## 4. Si falla el despliegue

Ver `rollback.md`. Las migraciones de base de datos van aparte (flujo «Migraciones» de GitHub Actions, secreto `SUPABASE_DB_URL`).
