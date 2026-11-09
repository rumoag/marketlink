# ADR 0022: Liquidación al entregar y retirada en dos tiempos con clave de idempotencia

- Estado: aceptado (**comprobación real pendiente del spike de U0, P5 a P7**)
- Fecha: 2026-11-07
- Unidad: U5 Dinero

## Decisión

1. **Liquidación** al pasar el pedido a `entregado`, con retraso configurable (`SETTLEMENT_DELAY_HOURS`, 0 por defecto). No hay liberación automática: un pedido 10 días en tránsito genera un único aviso `entrega_sin_confirmar`; el operador libera con motivo (`ReleaseDelivery`).
2. **Una transferencia por pedido:** `transfers.create` con `source_transaction` (ligada al cobro), `transfer_group = pedido`, clave `liquidar:<pedido>` y búsqueda previa por grupo. El `charge_id` se resuelve de forma perezosa al liquidar (`paymentIntents.retrieve`) y se guarda en `orders.charge_id`; sin cobro identificable no se transfiere y se avisa (`liquidacion_sin_cargo`).
3. **Cuenta no activa:** la liquidación queda `pendiente` con `blockReason`, se reintenta cada hora y a los 7 días se avisa una sola vez. Nunca se envía a otra cuenta.
4. **Retirada** (`PAYOUT_MODE=manual`): una transacción escribe la fila `solicitada` y el movimiento `retirada` **antes** de llamar a Stripe; la llamada va fuera de la transacción (10 s, sin reintento en la petición) con clave `retirar:<artista>:<n>`. Un resultado dudoso lo resuelve el trabajo `withdraw_payout` (busca por clave, reintenta con la misma clave y, agotados los intentos, restituye el saldo con un `ajuste`). Exige acceso con enlace mágico de ≤ 15 minutos y 5 retiradas por hora (fallo cerrado).
5. **`PAYOUT_MODE=automatico`:** la retirada se rechaza y Stripe paga con su calendario. En manual, las cuentas nuevas se crean con calendario `manual` y las existentes se actualizan con `scripts/ops/set-manual-payouts.mjs` (lista por defecto; `--apply` exige confirmación escrita).
6. **Reembolsos** solo antes de liquidar y solo con retención registrada: el envío primero, luego la parte de la artista; clave `reembolso:<pedido>:<n>`. Se rechazan si hay una transferencia en curso. `charge.refunded` y `charge.dispute.created` solo generan avisos.

## Riesgos abiertos

`source_transaction` hacia cuentas Express, el calendario manual y el pago a banco por API están escritos contra la documentación y los tipos del SDK; se comprueban en la fase 1 (sandbox) y la fase 2 (un ciclo real) del runbook `dinero.md`. Si Stripe no admite alguno, se cambia el adaptador sin tocar el dominio.
