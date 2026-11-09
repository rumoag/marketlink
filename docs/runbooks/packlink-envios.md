# Runbook: Packlink PRO (envíos, etiquetas y seguimiento)

Estado: **pendiente de ejecutar**. Complementa `packlink.md` (cotización). Los puntos marcados con ⚠ son supuestos que debe confirmar el spike de U0.

## 1. Webhook

1. ⚠ Comprueba si el plan permite registrar una integración con webhooks (P3 del spike). URL: `<URL estable>/api/webhooks/packlink`, cabecera `X-Packlink-Webhook-Secret` con `PACKLINK_WEBHOOK_SECRET` (distinto por entorno).
2. Eventos: `shipment.label.ready`, `shipment.carrier.success`, `shipment.tracking.update`, `shipment.delivered`, `shipment.carrier.delivered`, `shipment.label.fail`, `shipment.carrier.fail`.
3. Si no hay webhooks, rige la **consulta de respaldo** (15 min el primer día, 60 min después) sin cambios de código.

## 2. Fase 1 de la comprobación (sin gasto)

1. ⚠ Crear un **borrador sin pagarlo** (P4) con una referencia propia y cancelarlo; comprobar que `GET /v1/shipments?shipment_custom_reference=` lo encuentra.
2. ⚠ Formato de `GET /v1/shipments/{ref}` (estados y precio), de `/labels` (URL del PDF en `*.packlink.com`), de `/v1/dropoffs/{servicio}/ES/{cp}` y de las fechas de recogida; ajustar `PacklinkShipmentAdapter` y anotar el resultado en `docs/adr/0007`.
3. ⚠ Significado de `dropoff` por servicio (`punto` frente a `recogida`).

## 3. Fase 2 (antes de M2, con gasto)

Un envío real completo entre dos direcciones del titular, con un paquete pequeño: compra de prueba → borrador → pago de la etiqueta por el operador → etiqueta descargada → recogida o entrega en un punto → avisos hasta `entregado`. Anota fecha, coste real y resultado (y el margen calculado) en `docs/quotas.md`.

## 4. Si algo falla

- Aviso `packlink_borrador_fallido`: el pedido queda en `error_borrador`; reintento manual desde U6 (mientras tanto, reencolar `create_shipment_draft`).
- Aviso `etiqueta_no_descargada`: el pedido sigue en `borrador_creado`; revisar la etiqueta en Packlink.
- Aviso `incidencia_envio`: el pedido está en `incidencia` sin reembolso automático; el operador decide en U6.
- Aviso `borrador_sin_pagar`: pagar la etiqueta en Packlink PRO.
