# Runbook: desplegar en Vercel

Estado: **pendiente de ejecutar** (la base de datos de Supabase se crea después). La región de las funciones es `fra1` (`vercel.json`), cerca de Supabase en Fráncfort.

## 1. Proyecto

1. Cuenta de Vercel y la aplicación de GitHub de Vercel instalada con acceso al repositorio `rumoag/marketlink`.
2. Desde `marketlink/`: `vercel login`, `vercel link` y `vercel git connect` (o «Add New → Project» en el panel). La raíz del proyecto es la raíz del repositorio.
3. Framework: Next.js (se detecta). Versión de Node: 24.

## 2. Variables de entorno

Se definen por entorno (Preview y Production) con `vercel env add NOMBRE <entorno>`. **Nunca** en el repositorio.

| Variable                                                                                                                                 | Valor                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `APP_ENV`                                                                                                                                | `sandbox` (Preview); `live` solo en Production tras M2                 |
| `PRODUCT_NAME`, `LOG_LEVEL`                                                                                                              | nombre del producto y `info`                                           |
| `APP_URL`                                                                                                                                | la URL pública del despliegue (sin barra final)                        |
| `INTERNAL_JOBS_SECRET`, `RATE_LIMIT_SALT`, `MONITOR_SECRET`, `SESSION_COOKIE_SECRET`, `TRACKING_TOKEN_SECRET`, `OPERATOR_SESSION_SECRET` | aleatorios de 48 caracteres, distintos por entorno                     |
| `DATABASE_URL`                                                                                                                           | cadena de conexión del agrupador de Supabase (rol de aplicación)       |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`                                                                  | del proyecto de Supabase                                               |
| `STRIPE_SECRET_KEY`, `STRIPE_API_VERSION`                                                                                                | `sk_test_…` en Preview; la versión de API fijada                       |
| `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_PLATFORM_WEBHOOK_SECRET`                                                                        | de los destinos de eventos (`stripe-connect.md`, `stripe-checkout.md`) |
| `PACKLINK_API_KEY`, `PACKLINK_WEBHOOK_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `OPERATOR_EMAIL`, `CONTACT_EMAIL`                         | de cada proveedor                                                      |
| `OPERATOR_EMAILS`, `OPERATOR_TOTP_SECRETS`                                                                                               | `operador-acceso.md`                                                   |
| `PAYOUT_MODE`                                                                                                                            | `manual`                                                               |

`E2E_ENABLED` no se define nunca en Production (la configuración lo rechaza en `live`).

## 3. Después del primer despliegue

1. Comprobar `GET <APP_URL>/api/health` (público, mínimo) y `GET /api/health/deep` con `x-monitor-secret`.
2. Crear los destinos de eventos de Stripe con la URL pública (`stripe-connect.md`, apartado 3).
3. Revisar en los registros de Vercel que las funciones corren en `fra1`.
4. La subida de fotos usa `sharp`: confirmar que `POST /api/artista/fotos` responde con una foto real (límite de 30 s).

## 4. Si falla el despliegue

Ver `rollback.md`. Las migraciones de base de datos van aparte (flujo «Migraciones» de GitHub Actions, secreto `SUPABASE_DB_URL`).
