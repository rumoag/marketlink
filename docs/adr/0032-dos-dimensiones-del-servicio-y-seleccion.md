# ADR 0032 — Dos dimensiones del servicio de transporte y selección validada

Estado: aceptada (2026-11-11). Evoluciona el ADR 0007 (cotización) y se apoya en el spike del ADR 0031.

## Contexto

Hasta U7 un servicio de transporte tenía una sola dimensión, `modality` (la artista deja el paquete en un punto o lo recogen en su casa), y el comprador solo recibía el servicio más barato de la modalidad del enlace. La artista no podía aceptar varias formas de enviar y el comprador no podía elegir entre transportistas, plazos y entrega a domicilio o en un punto.

El spike del ADR 0031 confirmó que Packlink distingue ambas cosas: `dropoff` indica el **origen** y `delivery_to_parcelshop` el **destino**, el precio con IVA está en `price.total_price` y los puntos de destino salen del mismo endpoint que los de origen (`/v1/dropoffs/{servicio}/ES/{cp}`).

## Decisión

1. `ShippingService` gana `carrier` y `destination` (`domicilio` o `punto`). `modality` sigue siendo el **origen**.
2. El enlace guarda un conjunto de **orígenes aceptados** (`listings.origins`, uno o dos). Es una restricción: nunca se ofrece al comprador un servicio de un origen que la artista no aceptó, ni siquiera como alternativa (se retira el flujo de «alternativa aceptada»).
3. El catálogo de opciones son **funciones puras** del dominio (`acceptedServices`, `groupByDestination`, `pickHighlights`, `defaultOption`, `buildOptions`): dos grupos (a domicilio y en punto), hasta tres destacadas por grupo (la más barata, la más rápida y una intermedia, distintas y por precio ascendente) y una preselección (la más barata a domicilio; si no hay, la de punto). Son deterministas y no dependen del orden de entrada (P-U8-01 a P-U8-09).
4. **La selección se revalida sin estado al pagar.** El cliente manda `serviceId`, `pointId` y el total que vio; el servidor recalcula las opciones (casi siempre desde la caché del ADR 0033) y exige que el servicio esté entre ellas y, con destino punto, que el punto esté en la lista actual; con destino a domicilio no admite punto. Si algo no encaja, **no se cobra nada**: devuelve `servicio_no_disponible`, `punto_no_disponible`, `total_cambiado` o `no_shipping`/`shipping_down`, y las selecciones inválidas quedan en la auditoría (`delivery_selection_rejected`). El precio lo fija siempre el servidor.
5. El pedido guarda el servicio, el transportista, el plazo y el destino dentro de `orders.quote`, y el punto elegido dentro de `orders.destination`, de modo que se **purga con los datos personales**. Los pedidos anteriores se leen con valores por defecto.
6. El borrador de envío manda `dropoff_point_id` en la raíz del cuerpo cuando hay punto (ADR 0031).

## Consecuencias

- Migración aditiva y reversible: `origins` se rellena desde `modality`, un disparador mantiene `modality` derivada de `origins` (punto si se acepta, si no recogida) para que el código anterior siga funcionando durante el despliegue y la vuelta atrás. Otra migración posterior eliminará `modality`.
- Sin estado en el servidor ni tokens firmados nuevos: la validación depende de la caché y de Packlink, no de nada que el cliente pueda falsificar.
- Pendiente de comprobar con un pedido real: el borrador de un servicio de **recogida en casa con punto de destino** (no se puede verificar sin cuenta de Packlink de pago).
