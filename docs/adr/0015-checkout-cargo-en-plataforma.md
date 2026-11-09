# ADR 0015: Stripe Checkout con cargo en la plataforma y un pedido por intento

- Estado: aceptado
- Fecha: 2026-11-05
- Unidad: U3 Compra y pago

## Contexto

La compradora no tiene cuenta. El dinero debe quedar retenido en la plataforma hasta la entrega (U5) y la obra no puede venderse dos veces.

## Decisión

1. **Checkout alojado** de Stripe (sin tocar datos de tarjeta), **cargo en la plataforma** (no _destination charge_), dos líneas (obra y envío) con importes calculados siempre por el servidor. Sesión de 30 minutos (mínimo de Stripe); reserva de 32.
2. **Un pedido y una sesión nuevos por intento.** Cancelar o fallar crea un pedido nuevo; no se reutilizan sesiones. La clave de idempotencia de la sesión es el id del pedido; la del formulario (`submission_key`) evita dobles pedidos por doble clic.
3. **Venta única por tres capas:** candado de fila del enlace en `reserve`/`canSell`/`sell`, transición del pedido con versión optimista, e índice único parcial «un pedido pagado por enlace». El pedido perdedor pasa a `incidencia` y se reembolsa solo (clave `refund:<pedido>`).
4. **Tres redes de seguridad:** reintentos de la cola, respaldo por reloj cada minuto (consulta la sesión en Stripe antes de expirar) y conciliación diaria que solo informa.
5. **Metadatos de Stripe** con solo el id del pedido; el email viaja únicamente para el recibo.
6. **Una obra pausada con la reserva de un pedido pagado se vende** (`markSold(..., allowPaused)`): el pago ya se cobró; reembolsar por una pausa de la artista sería un mal resultado.
7. **Bizum** mediante `allowed_payment_method_types` solo con `BIZUM_ENABLED` (pendiente del spike de U0).

## Alternativas descartadas

- _Destination charge_: el dinero iría a la artista antes de la entrega.
- Reutilizar la sesión tras cancelar: complica la idempotencia y las carreras.
- Reservar solo por reloj: una sesión pagada en el último segundo se perdería; el margen de dos minutos y el reembolso automático cubren el caso.
