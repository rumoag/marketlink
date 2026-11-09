# ADR 0017: Cliente de Packlink propio, sin caché de cotizaciones

- Estado: aceptado
- Fecha: 2026-11-05
- Unidad: U3 Compra y pago

## Decisión

1. Cliente propio (`PacklinkShippingAdapter`) tras el puerto `ShippingProvider`, sobre el `fetch` resiliente: 5 s por intento, un reintento (solo GET) y circuito por proveedor. Sin SDK oficial fiable.
2. **Sin caché ni cotización guardada** (decisión de la usuaria, Q2 B): se cotiza al mostrar el total y se **recotiza al crear el pago**; si el total cambió no se crea pedido y se pide confirmar el nuevo importe. A cambio, si Packlink falla justo al pagar se pierde esa venta; la cuota se protege con `quote_ip` (20 cada 10 minutos) y los límites por IP y por enlace.
3. La respuesta se valida servicio a servicio (`isValidService`): precio entero entre 1 y 10.000 céntimos, modalidad conocida, tránsito acotado. Sin servicios válidos = «no se puede pagar»; **sin precio por defecto** (CQ2).
4. Mapeo provisional: `dropoff = true` → `punto`; `false` → `recogida`. **Por confirmar con el spike de U0** (`runbooks/packlink.md`).

## Si se necesitara caché

Se añade detrás del puerto (clave origen, destino, tamaño y modalidad, 6 h) sin tocar el dominio.
