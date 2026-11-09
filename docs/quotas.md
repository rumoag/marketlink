# Cuotas y límites de los planes (U1-NFR-SC3, RESILIENCY-09)

Los valores concretos **no están verificados**: se comprueban en cada consola al crear los proyectos y se anotan aquí con la fecha. La medición y el aviso al 80 % se completan en U7.

| Servicio         | Qué vigilar                                                                                                                                                        | Valor del plan (verificar) | Verificado el | Uso actual | Aviso |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------- | ---------- | ----- |
| Vercel           | Peticiones y duración de funciones; ancho de banda; uso comercial (Hobby no lo permite)                                                                            |                            |               |            | 80 %  |
| Vercel           | Retención de logs                                                                                                                                                  |                            |               |            |       |
| Vercel           | Frecuencia mínima de cron (plan alterno de la cola)                                                                                                                |                            |               |            |       |
| Supabase         | Proyectos activos; pausa por inactividad (plan gratuito)                                                                                                           |                            |               |            |       |
| Supabase         | Tamaño de base de datos; almacenamiento; transferencia                                                                                                             |                            |               |            | 80 %  |
| Supabase         | Conexiones del agrupador; copias gestionadas                                                                                                                       |                            |               |            |       |
| Supabase         | Disponibilidad de `pg_cron`, `pg_net` y Vault                                                                                                                      |                            |               |            |       |
| Resend           | Correos al día y al mes                                                                                                                                            |                            |               |            | 80 %  |
| Stripe           | Límite de peticiones; Bizum con cargos de plataforma (spike U0)                                                                                                    |                            |               |            |       |
| Packlink         | Límite de peticiones de la API (sin caché: una por cotización); precios y modalidades reales (U3)                                                                  |                            |               |            |       |
| Resend           | Envíos al día/mes del plan; dominio verificado (SPF, DKIM, DMARC); límite de peticiones (U4)                                                                       |                            |               |            |       |
| Packlink PRO     | Límite de peticiones; registro de integración (spike U0)                                                                                                           |                            |               |            |       |
| Supabase Auth    | Correos por hora con SMTP propio; duración mínima del enlace y del token de acceso; límites de sesión por plan                                                     |                            |               |            |       |
| Supabase Storage | Tamaño máximo por objeto (1 MB en `listing-images`); almacenamiento de fotos (unas 600 en dos tamaños, menos de 150 MB)                                            |                            |               |            | 80 %  |
| Vercel           | Cuerpo máximo de petición (≈ 4,5 MB; el servidor admite 4 MB por foto); memoria y duración de la ruta de fotos (1.024 MB, 30 s); tamaño del despliegue con `sharp` |                            |               |            |       |
| Resend           | Dominio verificado (sin él solo entrega al titular de la cuenta)                                                                                                   |                            |               |            |       |
| Stripe           | Endpoints de webhook por cuenta; límite de peticiones de la API                                                                                                    |                            |               |            |       |
| GitHub Actions   | Minutos al mes; retención de artefactos (copias)                                                                                                                   |                            |               |            | 80 %  |

Dimensionamiento del v0: hasta 10 artistas, 100 pedidos al mes y cientos de visitas diarias. El diseño admite 100 artistas y 1.000 pedidos al mes sin rediseño.

## U5 Dinero

| Servicio         | Qué vigilar                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe           | Transferencias, pagos a banco y reembolsos por minuto; eventos `charge.refunded` y `charge.dispute.created` añadidos al endpoint; comisiones reales por cobro (anotar tras la fase 2 del runbook `dinero.md`) |
| Supabase Storage | Bucket `finance-exports` (un CSV pequeño al mes, 6 años)                                                                                                                                                      |
| Vercel           | Retirada con límite de 10 s; trabajos `retry_settlements` (cada minuto) y `withdraw_payout` (cada 5 minutos)                                                                                                  |

## U6 Panel del operador

| Servicio      | Qué vigilar                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Supabase Auth | Correos por hora (el enlace del operador comparte el límite con las artistas); URL de redirección del panel |
| Resend        | Avisos de acceso y de bloqueo del operador (pocos al mes)                                                   |
| Postgres      | `listing_views` (una fila por obra y día, 24 meses) e índices de la lista de pedidos                        |
| Vercel        | Rutas del panel dinámicas; límite de peticiones del operador (120/min)                                      |

## U7 Transversales

| Servicio       | Qué vigilar                                                                               |
| -------------- | ----------------------------------------------------------------------------------------- |
| GitHub Actions | Minutos del mes y almacenamiento de artefactos (30 días de copias + restauración mensual) |
| UptimeRobot    | Un monitor cada 5 minutos entra en el plan gratuito                                       |
| Resend         | Un correo de acceso y, rara vez, avisos de seguridad                                      |
| Supabase       | `audit_events` crece sin limpieza: aviso a 1.000.000 de filas                             |

Revisión mensual: actualiza esta tabla y `QUOTAS_REVIEWED_AT` (ver `monitorizacion.md`).
