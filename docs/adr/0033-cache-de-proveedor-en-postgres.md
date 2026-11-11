# ADR 0033 — Caché de proveedor en Postgres con caducidad

Estado: aceptada (2026-11-11). Complementa el ADR 0032.

## Contexto

Calcular opciones de envío consulta a Packlink al escribir el código postal, al elegir un servicio con punto de destino y de nuevo al pagar (revalidación). Las funciones de Vercel no comparten memoria entre instancias, y repetir las mismas consultas gasta tiempo (objetivo p95 menor de 2 s) y cuota del proveedor.

## Decisión

- Tabla `provider_cache (key, payload jsonb, expires_at)` con RLS y sin acceso para la API pública, accesible por el rol de la aplicación a través del puerto `ProviderCache`.
- Claves: `quote:{cp origen}:{cp destino}:{bulto}:{peso}:{valor declarado}` para servicios y `points:{servicio}:{cp}` para puntos. **Sin datos personales.**
- Caducidad configurable (`QUOTE_CACHE_TTL_MINUTES`, 10 por defecto). **La lectura filtra `expires_at > now`: nunca se usa un dato caducado**; con la caché vencida y Packlink caído se devuelve un error temporal y no se permite pagar (un precio caducado podría no coincidir con el que cobra Packlink).
- Un fallo de lectura o escritura de la caché se registra (`provider_cache_error`) y no impide operar: se consulta a Packlink directamente.
- Limpieza: borrado oportunista de lo caducado hace más de una hora al escribir y purga diaria con `pg_cron` (04:10 UTC), directo en SQL para no depender de la cola.

## Alternativas descartadas

- Memoria de cada instancia: no se comparte y se pierde en frío.
- Servicio de caché externo: una dependencia más para una carga baja (unas pocas compras al día).
- Servir datos caducados si Packlink cae: riesgo de cobrar un precio desactualizado.
