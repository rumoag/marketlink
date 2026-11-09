# ADR 0021: Libro de dinero de solo inserción con saldos derivados en la misma transacción

- Estado: aceptado
- Fecha: 2026-11-07
- Unidad: U5 Dinero

## Decisión

1. **`ledger_entries` solo admite `SELECT` e `INSERT`** para el rol de la aplicación (sin `UPDATE` ni `DELETE`), con clave de idempotencia `entry_key` única y dos índices únicos parciales: un pedido solo se cobra y retiene una vez, y solo se liquida una vez por cubo.
2. **Cuatro cubos:** `stripe`, `retenido`, `disponible`, `plataforma`. Regla de conservación por pedido: lo cobrado en `stripe` es igual a lo repartido en los demás cubos; una conciliación diaria lo comprueba y **solo avisa**, nunca corrige.
3. **`artist_balances`** (con `CHECK ≥ 0`) se actualiza en la misma transacción que el libro, bloqueando la fila de la artista (`FOR UPDATE`). Orden de bloqueo: pedido → artista. Un trabajo diario recalcula los saldos desde el libro y avisa de cualquier diferencia.
4. **Importes** en céntimos enteros; el libro no guarda datos personales (referencias opacas del proveedor).
5. **Retención al pagar** dentro de `ProcessPaymentFact` (gancho `inTxPaid`) y **liquidación pendiente al entregar** dentro de `applyShipmentFactTx` (gancho `onDelivered`): ambas en la misma transacción que el cambio de estado (bandeja de salida).

## Consecuencias

Cualquier corrección se hace con un movimiento nuevo (`ajuste`), nunca editando el pasado. Los cobros manuales (Bizum directo a la artista) no pasan por la plataforma y no se registran.
