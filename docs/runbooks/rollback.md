# Runbook: rollback

Objetivo: volver a la versión anterior en minutos (RESILIENCY-04, U1-NFR-AV6). Estado: **pendiente de ensayo** (escenario R-05, una vez en vista previa antes de M2).

## Cuándo

Tras un despliegue que degrade el servicio (errores 5xx, página en blanco, cobros fallidos, cabeceras ausentes).

## Aplicación (Vercel)

1. Vercel → proyecto → _Deployments_.
2. Localiza el último despliegue de producción que funcionaba (el anterior al problema).
3. Menú del despliegue → **Promote to Production** (o `vercel promote <url-del-despliegue>`).
4. Comprueba `GET /api/health` (200 `{"status":"ok"}`) y `GET /api/health/deep` con el secreto de monitorización.
5. Anota el incidente en el PR o la incidencia que originó el cambio (nota de rollback de la plantilla).

## Base de datos

Las migraciones son **aditivas y compatibles hacia atrás**: la versión anterior de la aplicación funciona con el esquema nuevo, así que no se revierten en caliente.

- Si una migración fue la causa: corrige con una **nueva migración hacia delante** (por ejemplo, añadir de nuevo lo eliminado) y aplícala con el workflow _Migraciones_.
- Solo en caso grave (datos corruptos): restaurar la copia, ver `restauracion.md`.

## Flags

Si el problema está en una función concreta con flag (`PAYMENT_MANUAL_ENABLED`, `BIZUM_ENABLED`), desactívala en las variables de entorno de Vercel y redespliega la versión actual; es más rápido que un rollback.

## Después

- Registra qué falló, cuánto duró y qué lo evitaría (`docs/resilience/registro.md` si fue un incidente).
- Abre un PR de corrección con prueba que reproduzca el fallo.
