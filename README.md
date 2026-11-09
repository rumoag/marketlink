# MarketLink

Enlace de venta con envío para artistas independientes en España (nombre provisional; el nombre sale solo de la variable `PRODUCT_NAME`).

Estado: **v0, unidades U1 (Fundación) y U2 (Artistas y enlaces)**. Incluye el núcleo de dominio, la plataforma transversal (seguridad, resiliencia, observabilidad), la cola de trabajos, el acceso sin contraseña, el perfil, la dirección, los cobros con Stripe Connect y la creación de enlaces con fotos. La compra, el envío y el dinero llegan en U3 a U7. El diseño completo está en `aidlc-docs/`.

## Requisitos

- Node.js 24 y npm 11
- Un Postgres para las pruebas de integración y la ejecución local (Docker, o el que ya tengas)

## Arranque rápido

```bash
npm ci
cp .env.example .env        # y rellena los valores (ver más abajo)
npm run dev
```

Variables obligatorias: `APP_ENV` (`sandbox` o `live`), `DATABASE_URL`, `INTERNAL_JOBS_SECRET`, `RATE_LIMIT_SALT` y `SESSION_COOKIE_SECRET` (las tres últimas, de 32 caracteres o más), más las de Supabase y Stripe (ver `.env.example`).

**Modo de pruebas sin cuentas externas:** con `E2E_ENABLED=true` la aplicación usa dobles en proceso de Supabase Auth/Storage y de Stripe (y solo necesita Postgres). Sirve para desarrollar y para el E2E; la configuración lo rechaza con `APP_ENV=live`. Los enlaces de acceso se obtienen con `POST /api/test/sign-in-link` (cabecera `x-internal-secret`). Sin una configuración válida la aplicación responde 503 a todo (falla cerrada). Los secretos no se pegan nunca en el chat ni se suben a Git.

Base de datos local sin Supabase:

```bash
ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/marketlink \
APP_ROLE_PASSWORD=<elige-una> node scripts/db/apply-migrations.mjs
```

La aplicación se conecta con el rol `marketlink_app` (privilegios mínimos); no uses el rol propietario en `DATABASE_URL`.

## Scripts

| Comando                                 | Qué hace                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run typecheck`                     | Comprueba tipos (TypeScript estricto)                                        |
| `npm run lint` / `npm run format:check` | ESLint (seguridad, accesibilidad, límites de capas) y Prettier               |
| `npm test`                              | Pruebas unitarias (ejemplos)                                                 |
| `npm run test:properties`               | Pruebas de propiedades (fast-check); imprime la semilla                      |
| `npm run test:coverage`                 | Ambas, con umbral del 80 % en dominio y aplicación                           |
| `npm run test:integration`              | Pruebas contra Postgres real (`TEST_DATABASE_URL`; se omiten si no está)     |
| `npm run build` y `npm run test:e2e`    | Compila y prueba con Playwright (necesita `npx playwright install chromium`) |
| `npm run audit:prod` y `npm run sbom`   | Auditoría de dependencias de producción y SBOM CycloneDX                     |

Para reproducir un fallo de una propiedad: `FC_SEED=<semilla> npm run test:properties`.

## Estructura

```
src/app/                 rutas de Next.js (salud, endpoint interno de trabajos, interfaz)
src/proxy.ts             entrada: correlación, CSP con nonce, cabeceras, denegar por defecto, límite de tasa
src/modules/kernel/      dinero, resultados, errores, formatos españoles, fechas   (domain)
src/modules/platform/    configuración, logs, cliente HTTP, circuito, límite de tasa, auditoría
src/modules/jobs/        cola de trabajos en Postgres
src/modules/accounts/    acceso, sesión, perfil, dirección y estado de cobros   (U2)
src/modules/listings/    enlaces, fotos, reservas y tamaños                      (U2)
src/services/            composición y casos de uso que coordinan módulos        (U2)
src/ui/                  componentes y utilidades de interfaz                    (U2)
supabase/migrations/     migraciones aditivas y compatibles hacia atrás
tests/{unit,properties,integration,e2e,support}
docs/{adr,runbooks,resilience}
```

Cada módulo tiene `domain` (puro), `application` (casos de uso y puertos) e `infrastructure` (adaptadores). ESLint impide que el dominio dependa de las otras capas.

## Documentación

- Decisiones: `docs/adr/`
- Operación: `docs/runbooks/` (rollback, rotación de secretos y alta del rol de la aplicación, restauración, `supabase-auth.md`, `stripe-connect.md`)
- Datos personales: `docs/privacy-data-inventory.md`
- Proceso de cambios: `docs/change-process.md` y la plantilla de PR
- Cuotas de planes gratuitos: `docs/quotas.md`
- Pruebas de resiliencia: `docs/resilience/registro.md`

## CI/CD

`.github/workflows/`: `ci.yml` (calidad, integración, E2E, cadena de suministro), `migrate.yml` (migraciones con aprobación manual en producción) y `backup.yml` (copia cifrada diaria). Las rutas asumen que la raíz del repositorio es esta carpeta; si el repositorio contiene también `aidlc-docs/`, mueve `.github/` a la raíz y añade `working-directory: marketlink` a los pasos.
