# Runbook: configurar Stripe Connect (cuentas de artistas)

Estado: **verificado en el sandbox (2026-11-09)** con una cuenta v2 de prueba: creación, enlace de onboarding, onboarding completado (transferencias y pagos en estado `active`), cobro en la plataforma, transferencia ligada al cobro (`source_transaction`), saldo disponible en la cuenta conectada, calendario de pagos manual y pago al banco por API (ADR 0028 y 0029). Siguen pendientes: los eventos con una URL pública y el ciclo con dinero real (`dinero.md`, fase 2).

## 1. Cuenta de plataforma

1. Cuenta de Stripe con país España y **Connect activado** como plataforma.
2. Modo de prueba para sandbox. El modo real exige completar el perfil de plataforma y la verificación del negocio.
3. Nombre de la plataforma y marca: lo que verá el artista en el onboarding. Usa el **nombre definitivo del producto** antes de invitar al primer artista real (hoy «MarketLink» es provisional).

## 2. Cuentas conectadas de los artistas

Stripe no admite crear cuentas con la API v1 en plataformas nuevas, así que se usa **Accounts v2** (ADR 0028):

- Configuración **recipient** con la capacidad `stripe_balance.stripe_transfers` (nuestro modelo cobra en la plataforma y transfiere después), país **ES**, panel **Express**.
- Con panel Express, Stripe exige que la plataforma asuma comisiones y saldos negativos (`fees_collector` y `losses_collector` = `application`). Es una decisión de negocio: la plataforma responde de los saldos negativos de las cuentas. Revísala con el asesor antes de abrir a artistas reales.
- Los parámetros están en `ACCOUNT_CREATION_PARAMS` (`stripe-payout-adapter.ts`).
- Estado «cobros activos» = capacidades `stripe_transfers` **y** `payouts` en estado `active`, y cuenta no cerrada ni rechazada.
- ✅ Verificado en el sandbox: una cuenta con solo `stripe_transfers` se crea sin `card_payments`.

## 3. Webhook de cuentas conectadas

Los eventos de cuentas v2 son **eventos finos**: solo identifican la cuenta, y el trabajo `apply_account_event` consulta su estado.

1. Panel de Stripe → Developers → Event destinations → _Create destination_ → eventos de **tu cuenta** (cuentas v2), estilo **thin**.
2. URL: `<URL estable>/api/webhooks/stripe-connect`.
3. Eventos: `v2.core.account.updated`, `v2.core.account.closed`, `v2.core.account[configuration.recipient].capability_status_updated`, `v2.core.account[configuration.recipient].updated` y `v2.core.account[requirements].updated`.
4. Copiar el secreto de firma (`whsec_…`) a `STRIPE_CONNECT_WEBHOOK_SECRET` en Vercel (por entorno).
5. Repetir en modo real para producción con su propio secreto.
6. En local: `stripe listen --forward-thin-to localhost:3000/api/webhooks/stripe-connect --thin-events "v2.core.account.updated"` (ajusta los eventos; comprueba la sintaxis con `stripe listen --help`).
7. ⚠ Por verificar con una URL pública: que el destino entrega estos eventos para cuentas creadas por la plataforma y que la firma se valida con este secreto.

## 4. Variables de entorno

`STRIPE_SECRET_KEY` (`sk_test_` en sandbox, `sk_live_` en producción; la configuración rechaza cualquier discordancia), `STRIPE_API_VERSION` (se fija a mano; revisar el registro de cambios antes de subirla) y `STRIPE_CONNECT_WEBHOOK_SECRET`.

## 5. Comprobación manual obligatoria (una vez por entorno)

1. Con un artista de prueba con perfil y dirección, pulsa «Activar cobros»: debe abrirse el onboarding alojado de Stripe. Sin la app desplegada se puede probar con `node scripts/spike/spike-stripe.mjs --account` (imprime el enlace; caduca en minutos, se regenera ejecutándolo de nuevo).
2. Completa el onboarding de prueba con los datos de prueba de Stripe.
3. Al volver a `/artista/cobros` debe verse «Cobros activos» (por la consulta directa o por el webhook).
4. En el panel de Stripe, comprueba que los eventos `v2.core.account…` se entregaron con 2xx.
5. Simula una restricción (en modo de prueba, desde el panel de la cuenta conectada) y comprueba que sus enlaces pasan a «Pausado» y el panel muestra el aviso.
6. Reenvía el mismo evento desde Stripe: no debe cambiar nada (idempotencia).

## 6. Si Stripe rota o revoca claves

Ver `rotacion-secretos.md`. Tras rotar `STRIPE_CONNECT_WEBHOOK_SECRET`, los eventos con la firma antigua se rechazan con 400 y Stripe los reintenta: actualiza antes la variable en Vercel y despliega.

## U5: calendario de pagos y transferencias

Con `PAYOUT_MODE=manual` el adaptador fija el calendario manual de cada cuenta recién creada con la API de ajustes de saldo (`POST /v1/balance_settings` con la cuenta como actor); las existentes se actualizan con `scripts/ops/set-manual-payouts.mjs`. La plataforma transfiere al entregar y la artista retira con **Retirar**. Detalle y avisos en `dinero.md`. ✅ Verificado en el sandbox (P6, P7).
