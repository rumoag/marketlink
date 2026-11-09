# ADR 0029 — Resultado del spike de Stripe con cuentas v2 (P5 a P7)

Estado: aceptada (2026-11-09). Complementa el ADR 0007 y el ADR 0028.

## Qué se ejecutó

Contra el sandbox de una plataforma nueva de Stripe (versión de API `2026-10-28.endive`), con el script `scripts/spike/spike-stripe.mjs`.

| Pregunta                          | Resultado                                                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P5 Checkout con filtro de métodos | `allowed_payment_method_types: ['card']` se acepta. Sin filtro Stripe ofrece varios métodos europeos; **Bizum no aparece** en la cuenta de pruebas. El parámetro antiguo `payment_method_types` ya no se admite.     |
| P6 Cuenta de artista              | Con Accounts v2: crear (200), enlace de onboarding (200), onboarding completado con datos de prueba: `stripe_transfers` y `payouts` pasan a `active`. Basta pedir `stripe_transfers`; no hace falta `card_payments`. |
| P6 Transferencia                  | Cobro de 20 € en la plataforma y transferencia de 15 € a la cuenta conectada con `source_transaction`: 200. La cuenta conectada muestra 15 € disponibles.                                                            |
| P7 Pagos al banco                 | Calendario manual con `balance_settings` (200) y pago de 10 € al banco por API desde la cuenta conectada (200).                                                                                                      |

## Observaciones

- Tras el onboarding queda una exigencia pendiente de la artista (`identity.individual.documents.primary_verification`) con las dos capacidades ya activas. Nuestro resumen la trata como «cobros activos» (las capacidades mandan) y la cuenta pasaría a restringida si Stripe la hace vencer; el evento de cuenta lo reflejaría.
- Las cuentas de pruebas anteriores de la plataforma tienen calendario diario; `scripts/ops/set-manual-payouts.mjs` las lista.

## Pendiente

- Eventos de cuenta con una URL pública (destino de eventos).
- Reembolsos antes y después de liquidar, idempotencia de eventos y disputa de prueba, con la aplicación desplegada.
- Ciclo con dinero real de pocos euros (fase 2 de `dinero.md`).
