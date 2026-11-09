# ADR 0023: Exportación contable mensual en CSV y conciliación que no corrige

- Estado: aceptado
- Fecha: 2026-11-07
- Unidad: U5 Dinero

## Decisión

1. El trabajo `export_finance` (día 1, 05:00 UTC) genera `YYYY-MM.csv` con libro, liquidaciones, retiradas y reembolsos del mes anterior, sin datos personales, con importes en céntimos y en euros; se guarda en el bucket privado `finance-exports` (solo CSV, 5 MB, solo clave de servicio). Es idempotente (reescribe el mismo mes). Las celdas que empiezan por `=`, `+`, `-` o `@` se neutralizan contra inyección de fórmulas. Conservación: 6 años; la descarga por URL firmada llega en U6.
2. `reconcile_ledger` (03:45 UTC) y `recompute_balances` (03:50 UTC) comparan y **avisan** (`conciliacion_desajuste`); corregir es siempre una decisión humana con un movimiento nuevo.
3. Todos los avisos de dinero salen por `OperatorAlerts`: `liquidacion_bloqueada`, `liquidacion_fallida`, `liquidacion_sin_cargo`, `retirada_fallida`, `entrega_sin_confirmar`, `disputa_abierta`, `reembolso_externo`.
