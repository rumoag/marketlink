# ADR 0030 — Cola de trabajos acotada y priorizada

Estado: aceptada (2026-11-11). Complementa el ADR 0009 (cola de trabajos).

## Contexto

En el despliegue de prueba (Vercel y Supabase) la base de datos programaba, con `pg_cron`, unos trabajos periódicos cada minuto, 5 o 15 minutos, pero **nadie los procesaba**: faltaban en el Vault los secretos con los que el reloj llama a la aplicación. Su clave de deduplicación incluía el minuto, así que se encolaba uno por tipo y minuto: **más de 6.000 trabajos pendientes en unas 25 horas**.

La cola se reclamaba por orden de llegada. El aviso de un pago de Stripe (`process_stripe_event`) llegó a las 18:29, se aceptó y encoló bien, y quedó **detrás de miles de trabajos periódicos viejos**. El comprador y la artista vieron «Esperando el pago» durante horas aunque Stripe ya había cobrado. En producción esto sería un fallo grave.

## Decisión

1. **Un solo periódico pendiente por tipo.** Los trabajos que programa `pg_cron` cada minuto, 5 o 15 minutos usan una clave de deduplicación fija por tipo (`periodic:<tipo>`). Como mucho hay uno pendiente o en curso a la vez (BR-J7), así que la cola no puede crecer sin límite aunque nadie la consuma. Los diarios y mensuales ya llevaban fecha en su clave. Migración `20261110100000_job_queue_hardening.sql`.
2. **Los eventos, antes que los periódicos.** El reclamo ordena por «es periódico» y luego por hora de ejecución y de creación (`PERIODIC_JOB_TYPES` en el dominio de trabajos). Un pago, un envío o un reembolso nunca esperan detrás de tareas de mantenimiento, ni aunque se acumulen.
3. **Purga.** Los trabajos terminados (`succeeded`, `cancelled`) se borran a los 7 días con una programación directa en SQL (03:40 UTC), que no depende de la cola. Sin esto la tabla crece unas 7.500 filas al día.
4. **La salud lo detecta.** El trabajo listo más antiguo que lleva esperando más de 5 minutos pone `/operador/salud` en «Atención» y más de 30 en «Crítico». `/api/health/deep` devuelve `jobsOldestPendingSeconds` y pasa a `degraded` pasados 5 minutos, así que el monitor externo avisa sin más configuración.

## Consecuencias

- Una cola parada ya no oculta un pago: la salud avisa en minutos, y cuando el consumidor vuelve, lo importante se procesa primero.
- Un periódico que falla del todo (`failed`) no bloquea al siguiente, porque la clave fija solo cuenta los estados pendiente y en curso.
- Los periódicos no se «recuperan» las ejecuciones perdidas durante una parada: ejecutan una vez al volver el consumidor, que es lo que se quiere (son idempotentes).
- La consulta de reclamo ordena por una expresión además de por el índice parcial. Con la cola acotada (unas decenas de filas pendientes) el coste es despreciable.

## Verificación

Pruebas unitarias del orden con el almacén en memoria, y de integración con Postgres real: el evento más nuevo se reclama delante de 30 periódicos más viejos, y 50 intentos de encolar el mismo periódico dejan un solo trabajo. Pruebas de los umbrales de salud (monótona), de la salud profunda y de la pantalla del operador.
