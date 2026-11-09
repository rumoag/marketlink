# ADR 0026: Retención de 12 meses, limpieza por pedido y borrado a petición desde el panel

- Estado: aceptado (pendiente de confirmar con el asesor, EN-16)
- Fecha: 2026-11-09
- Unidad: U7 Transversales

## Decisión

1. **12 meses desde la entrega** (o desde el pago si nunca se entregó) para nombre, correo, teléfono y dirección de la compradora; se conservan importes, fechas, estados y referencias (sin datos personales). El plazo sale de `RETENTION_PERSONAL_MONTHS` y el texto de privacidad se genera de la misma configuración (`privacyFacts`).
2. **Limpieza diaria (`purge_personal_data`)** por lotes, **una transacción por pedido** con la fila bloqueada y la elegibilidad recalculada con el estado fresco; idempotente (`personalPurgedAt`); espera con reembolso, incidencia manual, liquidación pendiente o incidencia de envío. Un fallo en un pedido no revierte los demás y avisa (`limpieza_datos_fallida`).
3. **Borrado a petición** desde la ficha del pedido (motivo + TOTP fresco, límite de acciones del panel, auditoría `personal_data_erased`): mismo servicio en modo `on_demand`, que además protege la cadena activa de envío y el pedido sin pagar. Los datos de las artistas no se borran desde el panel.
4. **Contacto público** en `CONTACT_EMAIL` (obligatorio en live), distinto del correo de operación.

## Consecuencias

El pedido sigue existiendo (importes y fechas) tras la limpieza. Si el asesor pide otro plazo, se cambia la variable. La fecha de referencia de un pedido nunca entregado es la del pago.
