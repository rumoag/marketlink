# ADR 0011: Rol de base de datos de mínimos privilegios y límite de tasa en Postgres

- Estado: aceptado
- Fecha: 2026-11-04
- Unidad: U1 Fundación

## Decisiones

1. **Rol `marketlink_app`.** La aplicación no se conecta como propietario. El rol tiene privilegios solo sobre las tablas que usa y `audit_events` solo admite `INSERT` y `SELECT` (sin `UPDATE`, `DELETE` ni `TRUNCATE`): auditoría de solo inserción (SECURITY-14). El `LOGIN` y la contraseña se asignan fuera del repositorio (runbook de rotación de secretos).
2. **Privilegios por defecto de Supabase.** Supabase concede todo a `anon` y `authenticated` en tablas nuevas. Las migraciones los revocan y activan RLS sin políticas para esos roles. La prueba de integración reproduce los valores por defecto de Supabase y comprueba la denegación.
3. **Contadores de tasa.** Una sentencia `INSERT … ON CONFLICT DO UPDATE … RETURNING` incrementa de forma atómica (una operación por petición). El sujeto es un HMAC-SHA256 con sal secreta. Ventana fija por regla; limpieza diaria a las 48 h.
4. **Fallo cerrado.** En rutas marcadas `failClosed` (autenticación y pago) un fallo del almacén da 503; en lecturas públicas se permite la petición y se avisa en el log.

## Consecuencias

- Un compromiso de la aplicación no permite alterar la auditoría desde esa conexión.
- Las migraciones deben ejecutarse con otro rol (propietario), mediante `supabase db push` en CI.
- Limitación conocida: la ventana fija permite una ráfaga de hasta el doble del límite en la frontera entre ventanas. Aceptable a esta escala.
