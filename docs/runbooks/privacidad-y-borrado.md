# Runbook: privacidad y borrado de datos

## Plazos

| Dato                                                   | Plazo                                                               | Cómo                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------- |
| Pedidos sin pagar                                      | 30 días                                                             | Tarea `purge_unpaid_orders`                    |
| Datos personales de la compradora                      | **12 meses desde la entrega** (o desde el pago si nunca se entregó) | Tarea diaria `purge_personal_data` (04:30 UTC) |
| Etiquetas                                              | 30 días tras la entrega (90 si nunca se entrega)                    | Tarea `purge_labels_and_notifications`         |
| Avisos                                                 | 12 meses                                                            | Misma tarea                                    |
| Importes (libro, liquidaciones, retiradas, reembolsos) | 6 años, sin datos personales                                        | No se borran                                   |
| Visitas                                                | 24 meses                                                            | `purge_listing_views`                          |

La limpieza espera si el pedido tiene un reembolso en curso, una incidencia abierta, una liquidación pendiente o una incidencia de envío.

## Atender una petición de borrado

1. La persona escribe al correo de contacto (`CONTACT_EMAIL`).
2. **Comprueba su identidad**: debe escribir desde el correo del pedido o demostrar que lo es (referencia del pedido).
3. En el panel, abre la ficha del pedido → «Borrar datos personales» → motivo + código TOTP + confirmar.
4. Si se rechaza: _cadena de envío activa_ (espera a la entrega o reembolsa), _reembolso en curso_ o _incidencia abierta_ (ciérrala).
5. Responde a la persona: qué se eliminó y qué se conserva (importes y fechas, por obligación contable).
6. Peticiones de **artistas**: se tramitan con el asesor (obligaciones contables y de cobros); no se borran desde el panel.

## Cambiar el plazo

`RETENTION_PERSONAL_MONTHS` en Vercel. El aviso de privacidad cambia solo (sale de la configuración). Avisa al asesor antes de ampliarlo.
