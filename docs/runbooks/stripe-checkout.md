# Runbook: Stripe Checkout y webhook de la plataforma

Estado: **pendiente de ejecutar** (necesita cuenta de Stripe con Connect, ver `stripe-connect.md`).

## 1. Webhook de la plataforma (uno por entorno)

1. Panel de Stripe → Developers → Webhooks → _Add endpoint_ → **Account** (no _Connected accounts_).
2. URL: `<URL estable>/api/webhooks/stripe`.
3. Eventos: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`.
4. Copia el secreto `whsec_…` a `STRIPE_PLATFORM_WEBHOOK_SECRET` en Vercel (distinto del de cuentas conectadas) y redespliega.
5. En local: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.
6. Las vistas previas de Vercel no reciben webhooks: usan los dobles de E2E.

## 2. Métodos de pago

Tarjeta siempre. Bizum solo con `BIZUM_ENABLED=true` y tras confirmar en el spike de U0 que Stripe lo admite en Checkout con cargo en la plataforma (⚠). Si Bizum es asíncrono, comprueba que llegan `async_payment_succeeded` y `async_payment_failed`.

## 3. Comprobación manual obligatoria

**Fase 1 (sandbox, modo de prueba):** tarjeta correcta; rechazada; 3-D Secure; sesión caducada (espera 30 min o usa _Expire_); doble pago del mismo enlace desde dos navegadores (uno acaba reembolsado automáticamente); cancelar y reintentar (el formulario vuelve relleno, sin la casilla); reenviar un evento desde Stripe (no cambia nada); cambio de total al recotizar; Packlink caído (clave inválida) → no deja pagar; token de seguimiento alterado → respuesta genérica.

**Fase 2 (antes de M2, producción):** una compra real de 1 € a una obra de prueba de una artista de prueba; comprueba `pagado`, enlace vendido, seguimiento y página de éxito; reembolso total desde el panel de Stripe; anota fecha y resultado en `docs/quotas.md`. La ejecuta una persona (el asistente no introduce datos de pago).

## 4. Si algo falla

- Aviso `doble_pago` o `reembolso_fallido` (contador en `/api/health/deep`, eventos `operator_alert` en `audit_events`): revisa el pedido en `orders` y reembolsa a mano desde Stripe si hace falta.
- Aviso `conciliacion_desajuste`: compara la sesión de Stripe con el pedido; la conciliación no corrige nada sola.

## U5: eventos del cobro

Añade `charge.refunded` y `charge.dispute.created` al endpoint de la plataforma. Solo generan avisos al operador; los reembolsos se hacen desde el servicio de reembolsos (no desde el panel de Stripe) para que el libro los conozca.
