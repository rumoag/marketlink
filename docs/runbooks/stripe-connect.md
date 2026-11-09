# Runbook: configurar Stripe Connect (cuentas de artistas)

Estado: **pendiente de ejecutar**. El spike de U0 (`scripts/spike/spike-stripe.mjs`) debe confirmar los puntos marcados con ⚠ antes de invitar a artistas reales.

## 1. Cuenta de plataforma

1. Cuenta de Stripe con país España y **Connect activado** como plataforma.
2. Modo de prueba para sandbox. El modo real exige completar el perfil de plataforma y la verificación del negocio.
3. Nombre de la plataforma y marca: lo que verá el artista en el onboarding. Usa el **nombre definitivo del producto** antes de invitar al primer artista real (hoy «MarketLink» es provisional).

## 2. Cuentas conectadas de los artistas

- Tipo **Express**, país **ES**.
- Capacidad solicitada: **`transfers`** (nuestro modelo cobra en la plataforma y transfiere después). Está en `REQUESTED_CAPABILITIES` (`stripe-payout-adapter.ts`).
- ⚠ **Por confirmar con el spike:** que una cuenta Express española con solo `transfers` se puede crear y activar. Si Stripe exigiera también `card_payments` (o el acuerdo de servicio «recipient», que podría no estar disponible para cuentas nacionales), se añade en esa constante y se documenta aquí.
- Estado «cobros activos» = `capabilities.transfers = active` **y** `payouts_enabled = true` **y** sin `requirements.disabled_reason`. (Corrige el criterio original de US-004, que hablaba de `charges_enabled`.)

## 3. Webhook de cuentas conectadas

1. Panel de Stripe → Developers → Webhooks → _Add endpoint_ → **Connected accounts** (tipo Connect).
2. URL: `<URL estable>/api/webhooks/stripe-connect`.
3. Evento: `account.updated`.
4. Copiar el secreto de firma (`whsec_…`) a `STRIPE_CONNECT_WEBHOOK_SECRET` en Vercel (por entorno).
5. Repetir en modo real para producción con su propio secreto.
6. En local: `stripe listen --forward-connect-to localhost:3000/api/webhooks/stripe-connect`.

## 4. Variables de entorno

`STRIPE_SECRET_KEY` (`sk_test_` en sandbox, `sk_live_` en producción; la configuración rechaza cualquier discordancia), `STRIPE_API_VERSION` (se fija a mano; revisar el registro de cambios antes de subirla) y `STRIPE_CONNECT_WEBHOOK_SECRET`.

## 5. Comprobación manual obligatoria (una vez por entorno)

1. Con un artista de prueba con perfil y dirección, pulsa «Activar cobros»: debe abrirse el onboarding alojado de Stripe.
2. Completa el onboarding de prueba con los datos de prueba de Stripe.
3. Al volver a `/artista/cobros` debe verse «Cobros activos» (por la consulta directa o por el webhook).
4. En el panel de Stripe, comprueba que el evento `account.updated` se entregó con 2xx.
5. Simula una restricción (en modo de prueba, desde el panel de la cuenta conectada) y comprueba que sus enlaces pasan a «Pausado» y el panel muestra el aviso.
6. Reenvía el mismo evento desde Stripe: no debe cambiar nada (idempotencia).

## 6. Si Stripe rota o revoca claves

Ver `rotacion-secretos.md`. Tras rotar `STRIPE_CONNECT_WEBHOOK_SECRET`, los eventos con la firma antigua se rechazan con 400 y Stripe los reintenta: actualiza antes la variable en Vercel y despliega.

## U5: calendario de pagos y transferencias

Con `PAYOUT_MODE=manual` las cuentas Express se crean con `settings.payouts.schedule.interval = manual`; las existentes se actualizan con `scripts/ops/set-manual-payouts.mjs`. La plataforma transfiere al entregar y la artista retira con **Retirar**. Detalle y avisos en `dinero.md`. **Pendiente de comprobar en sandbox (P6, P7).**
