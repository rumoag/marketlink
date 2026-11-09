# ADR 0018: Hechos de transporte, máquina de estados solo hacia delante y respaldo por consulta

- Estado: aceptado
- Fecha: 2026-11-06
- Unidad: U4 Envío y seguimiento

## Contexto

Packlink avisa por webhook, pero el spike de U0 (P3) no ha confirmado que el plan gratuito permita registrarlos. Los eventos llegan repetidos, desordenados o perdidos.

## Decisión

1. **Un solo contrato interno:** `ShipmentFact` (`draft_created`, `draft_failed`, `label_ready`, `in_transit`, `delivered`, `label_failed`, `carrier_failed`, `tracking_info`). `reduceProviderEvent` (pura y total) convierte el cuerpo de un webhook en un hecho; `fetchFacts` convierte el estado consultado en los mismos hechos.
2. **`applyFact` pura y solo hacia delante:** un destino de rango igual o menor no cambia nada; un hecho del proveedor anterior al último aplicado se ignora; los saltos hacia delante se admiten; la incidencia de envío (fallo de etiqueta o de transportista) solo se abre desde `borrador`, `etiqueta_lista` o `en_transito` y se recupera con un hecho de rango mayor.
3. **Un envío por pedido** (`shipments.order_id` único). `ProcessShipmentFact` bloquea envío y pedido, aplica el hecho, guarda coste y margen, registra los eventos de pedido y las notificaciones en la misma transacción.
4. **La etiqueta primero:** `label_ready` descarga y guarda el PDF antes de pasar a `etiqueta_lista`; si falla, el pedido sigue en `borrador_creado` y se reintenta.
5. **Respaldo por consulta:** `shipments.next_poll_at` y `claimDueForPolling` (`FOR UPDATE SKIP LOCKED`, lote de 20); 15 min el primer día, 60 min después. Si Packlink no ofrece webhooks, es la única vía sin cambiar el dominio.
6. **Incidencia de envío ≠ doble pago:** ambas usan el estado `incidencia`, pero la de envío no reembolsa; la decide el operador (U6).

## Consecuencias

- La estimación del margen (comisión de Stripe 1,5 % + 0,25 €) es una aproximación y puede salir negativa.
- El formato real de los eventos y de la consulta de Packlink se confirma con el spike (`runbooks/packlink-envios.md`); la lectura es tolerante.
- Se usa `<` y no `≤` para ignorar hechos anteriores: dos hechos del mismo segundo no se descartan entre sí.
