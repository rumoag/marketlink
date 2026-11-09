# Objetivos de servicio y criticidad

## Objetivos (v0)

| Objetivo                      | Valor                                           | Cómo se mide                                                                   |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Disponibilidad                | 99,5 % mensual (unas 3,6 horas de caída al mes) | Monitor externo sobre `/api/health` (informe mensual de UptimeRobot)           |
| RTO (tiempo de recuperación)  | 8 horas                                         | Restauración de prueba mensual y runbook `restauracion.md`                     |
| RPO (pérdida máxima de datos) | 24 horas                                        | Copia lógica diaria; la pantalla de salud avisa si la última tiene más de 36 h |

## Criticidad por componente

| Componente                                           | Criticidad | Por qué                           | Degradación aceptada                                                                |
| ---------------------------------------------------- | ---------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| Pago y dinero (Stripe, libro, liquidación, retirada) | Crítico    | Es dinero de terceros             | Sin Stripe no se cobra ni se liquida; nada se pierde y los trabajos se ponen al día |
| Pedidos y envío (Packlink, borradores, seguimiento)  | Alto       | Sin ellos no se entrega           | Sin Packlink se cobra y el borrador se reintenta                                    |
| Notificaciones (Resend)                              | Alto       | Informan a artistas y compradoras | Los correos se encolan y se reintentan                                              |
| Panel del operador y métricas                        | Medio      | Operación interna                 | Puede estar caído horas sin afectar a las ventas                                    |
| Contador de visitas                                  | Bajo       | Solo métricas                     | Fallo abierto: no se cuenta                                                         |

## Qué hacer si no se cumple

Abrir una incidencia (`incident-process.md`), anotar la causa y la acción preventiva y, si se perdió disponibilidad por una dependencia, revisar si hace falta cambiar de plan o de proveedor.
