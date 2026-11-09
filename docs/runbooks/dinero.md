# Runbook: dinero (liquidación, retirada, reembolsos y conciliación)

## Cómo fluye el dinero

Pago confirmado → **retención** en el libro (cobro, retención de la obra, envío de la plataforma) → entrega confirmada (hecho de transporte o liberación manual) → **liquidación pendiente** → `pg_cron` (cada minuto) → **transferencia** ligada al cobro a la cuenta Express → saldo **disponible** → la artista pulsa **Retirar** → pago a su banco. El envío nunca se transfiere: se queda en la plataforma.

## Variables

| Variable                        | Valor                   | Notas                                                                                      |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `PAYOUT_MODE`                   | `manual` o `automatico` | Obligatoria en producción. En `manual` las cuentas se crean con calendario de pagos manual |
| `SETTLEMENT_DELAY_HOURS`        | 0                       | Retraso entre la entrega y la liquidación                                                  |
| `STALE_DELIVERY_DAYS`           | 10                      | Aviso `entrega_sin_confirmar`                                                              |
| `SETTLEMENT_BLOCKED_ALERT_DAYS` | 7                       | Aviso `liquidacion_bloqueada`                                                              |
| `RECENT_LOGIN_MINUTES`          | 15                      | Acceso reciente exigido para retirar                                                       |

## Avisos y qué hacer

| Aviso                    | Significado                                           | Acción                                                                                                       |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `liquidacion_bloqueada`  | Lleva 7 días pendiente (normalmente cuenta no activa) | Pide a la artista que active sus cobros en **Cobros**; se liquida sola al activarse                          |
| `liquidacion_sin_cargo`  | No se encontró el cobro del pago                      | Busca el pago en Stripe, confirma que está cobrado y guarda `orders.charge_id`; el reintento horario liquida |
| `liquidacion_fallida`    | 5 intentos de transferencia fallidos                  | Revisa el panel de Stripe; si es transitorio, pon la liquidación en `pendiente` (`next_attempt_at = now()`)  |
| `retirada_fallida`       | El pago a banco falló y el saldo se restituyó         | Revisa la cuenta bancaria de la artista en Stripe                                                            |
| `entrega_sin_confirmar`  | 10 días en tránsito                                   | Reclama al transportista; si se entregó, **libera con motivo**; si no, reembolsa                             |
| `disputa_abierta`        | `charge.dispute.created`                              | Responde en el panel de Stripe en plazo; no mueve dinero solo                                                |
| `reembolso_externo`      | Reembolso hecho fuera del servicio                    | Regístralo: el libro no lo conoce hasta que se corrija con un ajuste                                         |
| `conciliacion_desajuste` | Libro y saldos (o conservación por pedido) no cuadran | Compara con Stripe; corrige con un movimiento `ajuste`, nunca editando filas                                 |

## Frenar el dinero sin desplegar

Parar `retry_settlements` (las liquidaciones quedan `pendiente`) y poner `PAYOUT_MODE=automatico` (la retirada se rechaza con explicación). No se pierde nada: al reanudar, los trabajos se ponen al día.

## Calendario manual de pagos

```bash
STRIPE_SECRET_KEY=sk_test_... node scripts/ops/set-manual-payouts.mjs
STRIPE_SECRET_KEY=sk_test_... node scripts/ops/set-manual-payouts.mjs --apply
```

Sin `--apply` solo lista. Con `--apply` pide escribir `APLICAR <n>` (`APLICAR LIVE <n>` con clave de producción).

## Comprobación obligatoria con Stripe (la hace una persona)

**Fase 1 (sandbox):** compra completa → entrega (panel simulado o liberación manual) → transferencia ligada al cobro a una cuenta Express de prueba → saldo disponible → pago a banco con calendario manual → reembolso total y parcial antes de liquidar → rechazo del reembolso tras liquidar → reenvío de eventos de Stripe (idempotencia) → una disputa de prueba. Anota el resultado en `docs/adr/0007-spike-u0-results.md` (P5, P6, P7).

**Fase 2 (antes de M2, producción):** un ciclo real de pocos euros con una artista de prueba hasta que el dinero llega a su banco; anota fecha, importe, comisiones reales, plazo y margen calculado en `docs/quotas.md`.

**Webhook de la plataforma:** añade los eventos `charge.refunded` y `charge.dispute.created` al endpoint `/api/webhooks/stripe` (sandbox y producción).

## Exportación contable

`finance-exports/YYYY-MM.csv` (el día 1). Para regenerar un mes, ejecuta el trabajo `export_finance`; reescribe el mismo fichero.
