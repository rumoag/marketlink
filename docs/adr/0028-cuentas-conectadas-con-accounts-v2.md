# ADR 0028 — Cuentas conectadas con Stripe Accounts v2

Estado: aceptada (2026-11-09). Sustituye la decisión de crear cuentas Express con la API v1 (U2, BR2-CB4).

## Contexto

Al ejecutar por primera vez el spike contra un Stripe real (cuenta de plataforma nueva, versión de API `2026-10-28.endive`), `POST /v1/accounts` respondió 400: Stripe ya no recomienda Accounts v1 para integraciones nuevas y exige `POST /v2/core/accounts`. La alternativa era activar en el Dashboard una compatibilidad con v1; se descartó para no construir sobre una API que Stripe retira del camino recomendado.

El flujo de dinero (cobro en la plataforma, transferencia ligada al cobro, retirada, reembolso) no depende de la versión de cuentas: las transferencias usan el identificador `acct_…`, que es el mismo.

## Decisión

1. **Creación.** `POST /v2/core/accounts` con país `es`, `dashboard: express`, `defaults.responsibilities` (`fees_collector` y `losses_collector` = `application`) y la configuración `recipient` con solo la capacidad `stripe_balance.stripe_transfers`. Con panel Express Stripe exige que la plataforma asuma comisiones y saldos negativos; es lo mismo que ya ocurría con las cuentas Express de v1. La clave de idempotencia es `create_account_v2:<artista>`. Los parámetros son una constante exportada (`ACCOUNT_CREATION_PARAMS`) que el spike repite tal cual.
2. **Onboarding.** `POST /v2/core/account_links` con `use_case.type = account_onboarding`. No hay que indicar configuraciones.
3. **Estado.** `GET /v2/core/accounts/{id}` con `include[0]=configuration.recipient&include[1]=requirements` (la sintaxis `include[]` no se admite). El resumen del dominio se deriva así:
   - `transfersActive` y `payoutsEnabled`: estado `active` de `stripe_transfers` y de `payouts`.
   - `detailsSubmitted`: ninguna exigencia espera ya al artista (`awaiting_action_from = user`); si solo esperan a Stripe, faltan verificaciones, no datos.
   - `disabled`: cuenta cerrada o capacidad `rejected`.
4. **Calendario manual (U5).** `POST /v1/balance_settings` con la cabecera `Stripe-Account` y `payments[payouts][schedule][interval]=manual`, justo después de crear la cuenta. Si falla, la creación falla y el reintento (idempotente) vuelve a fijarlo.
5. **Eventos.** Los eventos de cuentas v2 son «finos»: identifican la cuenta pero no traen su estado. La ruta de ingesta verifica la firma (`parseEventNotification`), guarda solo `{cuenta, instante}` y encola el trabajo; **el trabajo consulta el estado actual** y lo aplica. Se procesan `v2.core.account.updated`, `.closed`, `[configuration.recipient].*` y `[requirements].updated`. El instante del resumen aplicado es el máximo entre la lectura y el evento: una lectura antigua no pisa a una más reciente (P-U2-11 se mantiene).

## Consecuencias

- Menos datos en reposo: la tabla de eventos ya no guarda un resumen de la cuenta.
- Una llamada más a Stripe por evento, dentro del trabajo (reintentable, con circuito y espera), no en la respuesta del webhook.
- El destino de eventos de Stripe debe suscribirse a los eventos de cuenta v2 (runbook). Pendiente de verificar con una URL pública en el despliegue de prueba.
- La herramienta `scripts/ops/set-manual-payouts.mjs` recorre las cuentas v2 y usa los ajustes de saldo.
- Hallazgos del sandbox que no cambian el diseño: Bizum no aparece entre los métodos de la cuenta de pruebas (coherente con ir tras un flag), y el filtro `allowed_payment_method_types` de Checkout es válido en esta versión de API.
