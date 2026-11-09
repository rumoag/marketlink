# ADR 0019: Correo con cliente propio de Resend, en texto plano y con bandeja de salida

- Estado: aceptado
- Fecha: 2026-11-06
- Unidad: U4 Envío y seguimiento

## Decisión

1. **Cliente propio** (`ResendEmailSender`, `POST /emails`) sobre el `fetch` resiliente (10 s, circuito, `Idempotency-Key` por notificación); sin el SDK oficial, para no añadir dependencias de producción.
2. **Solo texto plano**, sin imágenes ni enlaces de rastreo propios; el enlace al pedido lleva a una página con sesión. Sin datos sensibles en el correo (ni calle ni teléfono).
3. **Bandeja de salida:** `notifications` se inserta con el cambio de estado, en la misma transacción; `dispatch_notifications` (cada minuto y disparado tras confirmar) toma lotes con `FOR UPDATE SKIP LOCKED`, resuelve el destinatario al enviar y reintenta con retroceso (1 min, 5 min, 30 min, 2 h, 12 h). Una por tipo y pedido (índice único).
4. **Sin datos personales en la tabla:** ni cuerpo ni dirección de email; si los datos de la compradora ya se purgaron, la notificación queda `fallida` con `sin_destinatario`.
5. **Fuera de `live` los correos nunca van a personas reales:** `EMAIL_SANDBOX_REDIRECT` es obligatoria (la configuración se niega a arrancar sin ella), y el asunto se prefija con `[PRUEBA]`.
6. Errores: 5xx y 429 son reintentables; el resto de 4xx son permanentes.

## Consecuencias

Sin dominio verificado Resend solo entrega al titular de la cuenta (`runbooks/resend.md`). Añadir HTML más adelante no cambia el modelo.
