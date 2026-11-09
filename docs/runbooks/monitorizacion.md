# Runbook: monitorización y salud

## Monitor externo (UptimeRobot, plan gratuito)

1. Crea una cuenta en UptimeRobot y un monitor **HTTP(S)**:
   - URL: `https://<dominio>/api/health`
   - Intervalo: 5 minutos.
   - Palabra clave (opcional): `ok`.
2. Contacto de alerta: tu correo. Activa el aviso tras **2 fallos seguidos**.
3. Prueba: pausa el despliegue o apunta el monitor a una URL inexistente y comprueba que llega el aviso; vuelve a dejarlo bien.
4. Cada mes anota el porcentaje de disponibilidad (objetivo 99,5 %, ver `sla.md`).

El endpoint superficial es público y no revela nada; la comprobación profunda (`/api/health/deep`) lleva un secreto y no la hace el monitor.

## Pantalla de salud (`/operador/salud`)

| Estado           | Significa                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Correcto (verde) | Todo en orden                                                                                                                    |
| Atención (ámbar) | Trabajos o correos fallidos, copia de más de 36 h (o sin registro en live), circuito abierto o cuotas sin revisar más de 35 días |
| Crítico (rojo)   | La base no responde o la copia tiene más de 72 h                                                                                 |

Los circuitos de proveedores son los de la instancia que sirve la página (en un entorno sin estado, un circuito abierto aquí no implica que lo esté en otra).

## Revisión mensual de cuotas

1. Revisa en cada panel de proveedor el consumo del plan (umbral del 80 %): Stripe, Packlink PRO, Resend, Supabase, Vercel, GitHub Actions y UptimeRobot.
2. Actualiza `docs/quotas.md` y la fecha `QUOTAS_REVIEWED_AT` de `src/modules/operator/domain/quota-review.ts` (si no, la pantalla de salud pasa a ámbar a los 35 días).

## Métricas de latencia y errores

Panel de Vercel (registros de ejecución y análisis de rendimiento). El plan gratuito conserva los registros poco tiempo: para seguridad se usa siempre la auditoría en base de datos.
