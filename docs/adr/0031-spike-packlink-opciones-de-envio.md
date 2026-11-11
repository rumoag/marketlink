# ADR 0031 — Spike de Packlink para las opciones de envío (U8, EN-22)

Estado: aceptada (2026-11-11). Complementa el ADR 0007 y el runbook `packlink-envios.md`.

## Qué se hizo

Con la clave real de Packlink PRO del operador: consultas de solo lectura (servicios, puntos, envíos) y **dos borradores de prueba ficticios** (referencias `U8-SPIKE-A` y `U8-SPIKE-B`), creados con el permiso del usuario y **sin pagar**. Los borradores se borran a mano en Packlink PRO.

## Resultados

| Pregunta                                                   | Resultado                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ¿Qué dimensiones tiene un servicio?                        | Dos independientes: `dropoff` (origen: la artista lleva el paquete a un punto) y `delivery_to_parcelshop` (destino: el comprador lo recoge en un punto o locker). En el envío, `service_info.is_drop_off_in_origin` y `is_drop_off_in_destination`.                                                  |
| ¿De dónde salen los puntos de destino?                     | `GET /v1/dropoffs/{servicio}/ES/{código postal}`, el mismo endpoint que ya usamos para el origen, con el código postal del comprador. Devuelve de 10 a 30 puntos con `id`, `commerce_name`, `address`, `city`, `zip`, `opening_times`, `lat`, `long`, `phone`, `type`, `carrier`. **Sin distancia.** |
| ¿Con qué campo se indica el punto en el borrador?          | `dropoff_point_id` en la raíz del cuerpo. Packlink responde 201 y lo guarda.                                                                                                                                                                                                                         |
| ¿Qué precio se cobra?                                      | `price.total_price`, con IVA (21 %): 6,53 € frente a 5,40 € de `base_price`. Es lo que se paga en Packlink PRO. La app ya lo usa.                                                                                                                                                                    |
| ¿Cómo vienen los plazos?                                   | `transit_hours` (`"72"`) y `transit_time` (`"3 DAYS"`). También `first_estimated_delivery_date` y `first_collection_date`.                                                                                                                                                                           |
| ¿Qué significa `AWAITING_COMPLETION`?                      | Es el estado normal de **cualquier** borrador creado por API hasta que se paga, también con todos los datos puestos y con el precio aún vacío. **No indica que falten datos.**                                                                                                                       |
| ¿Qué hace falta para que el borrador vaya directo al pago? | Nombre, apellido y correo de remitente y destinatario, y el punto de destino cuando el servicio entrega en punto. Con los dos borradores de prueba, Packlink PRO los mandó directos al pago sin pedir nada más.                                                                                      |
| ¿Hay un endpoint que valide un borrador o diga qué falta?  | No: `/validate`, `/errors` y `/summary` dan 404.                                                                                                                                                                                                                                                     |

## Decisiones

1. **Puntos:** al elegir un servicio con entrega en punto, la app pide el punto con `GET /v1/dropoffs/{servicio}/ES/{código postal del comprador}` y manda `dropoff_point_id` al crear el borrador.
2. **Precio:** se sigue cobrando `price.total_price`.
3. **Distancia:** no se muestra, porque Packlink no la da. Los puntos se listan en el orden en que se reciben. Si más adelante se quiere distancia, se calcula con las coordenadas (`lat`, `long`) contra el centro del código postal.
4. **Borradores:** la app **no** deduce «incompleto» del estado. El requisito FR-U8-16 se cambió por vigilar los borradores que llevan demasiado tiempo sin pagarse, que es lo que importa al operador.
5. **Servicio de origen:** el origen en punto de la artista no necesita un id de punto para crear el borrador; la artista deja el paquete en el punto que elija tras la venta, como hoy.

## Consecuencias

- El defecto que dejaba borradores sin pagar era la falta de apellido, de correo del remitente y del punto de destino. Los dos primeros están corregidos; el tercero lo cubre U8.
- Los borradores de prueba `ES2026PRO0003317328` y `ES2026PRO0003317329` no se deben pagar.
- Pendiente de comprobar con un pedido real de prueba, ya con U8 construida, que el borrador con punto de destino y servicio de recogida en casa también va directo al pago.
