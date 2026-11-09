# ADR 0009: Cola de trabajos en Postgres

- Estado: aceptado
- Fecha: 2026-11-04
- Unidad: U1 Fundación

## Contexto

Hace falta procesar trabajos en segundo plano (pagos confirmados, etiquetas, avisos) con reintentos y sin añadir un servicio. El cómputo es serverless (Vercel), por lo que no hay procesos de larga duración.

## Decisión

- Tabla `jobs` en Postgres. El reclamo es una sola sentencia con `FOR UPDATE SKIP LOCKED` que marca `running`, suma un intento y fija el bloqueo (5 min): dos ejecutores nunca toman el mismo trabajo.
- Un bloqueo vencido se recupera en una sola sentencia que renueva el bloqueo (solo un ejecutor audita y avisa) y la cola decide: reintento o `failed`.
- Reintentos tras el intento 1 a 5: 1 min, 5 min, 30 min, 2 h, 12 h. Seis intentos como máximo.
- `dedupeKey` con índice único parcial sobre los estados no terminales.
- Disparo: inmediato tras encolar (`triggerJobRun`, con `after()` de Next.js) y `pg_cron` cada minuto como red de seguridad, ambos hacia `/api/internal/jobs/run`, protegido por secreto en tiempo constante.
- Un fallo terminal deja `AuditEvent(job_failed)` y una alerta al operador (en U1 solo se registra).

## Plan alterno si `pg_cron` o `pg_net` no están disponibles

La migración `20261104120500_schedules.sql` es condicional: sin las extensiones no hace nada. Alternativa: cron de Vercel una vez al día (Hobby) y una acción programada de GitHub Actions cada pocos minutos que llame al mismo endpoint, además del disparo inmediato. Se decide al crear el proyecto de Supabase (ver `aidlc-docs/.../infrastructure-design.md`, puntos a verificar).

## Consecuencias

- Sin dependencias nuevas. Latencia de segundos para casos normales.
- La función serverless tiene un presupuesto de tiempo (25 s por lote); el resto se procesa en el ciclo siguiente.
- Los manejadores deben ser idempotentes: un trabajo puede ejecutarse más de una vez si el proceso muere tras actuar y antes de resolver.
