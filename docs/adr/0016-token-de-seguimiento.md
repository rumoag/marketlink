# ADR 0016: Token de seguimiento derivado con HMAC y doble secreto

- Estado: aceptado
- Fecha: 2026-11-05
- Unidad: U3 Compra y pago

## Contexto

La compradora consulta su pedido sin cuenta. El token viaja en la URL, así que debe ser inadivinable, no contener datos personales y no poder reconstruirse con un volcado de la base. La página de éxito (y el email de U4) necesitan volver a mostrarlo.

## Decisión

1. `token = base64url(HMAC-SHA-256(secreto, "seguimiento:" + pedido + ":" + nonce))` (43 caracteres, 256 bits); el `nonce` es aleatorio (128 bits) y se guarda en el pedido.
2. En base de datos solo se guarda `SHA-256(token)` (único). La consulta calcula el resumen del token recibido; token mal formado, desconocido o limitado dan la misma respuesta genérica.
3. **Doble secreto** (`TRACKING_TOKEN_SECRET` y `_PREVIOUS`): el pedido guarda la huella (`token_key_id`, 8 caracteres) del secreto con el que se emitió. Tras rotar, los enlaces ya entregados siguen funcionando (la búsqueda es por resumen) y se pueden volver a derivar mientras el anterior siga configurado; se retira a los 90 días.
4. Respuestas con `Cache-Control: no-store` (pipeline), `Referrer-Policy: no-referrer` y la ruta enmascarada en logs y auditoría (`/seguimiento/[token]`).

## Consecuencias

Precisa la decisión de «token aleatorio» del diseño funcional: mantiene la garantía (256 bits) y permite mostrarlo sin almacenarlo. Perder todos los secretos impide volver a mostrar un token, no consultar con el token guardado.
