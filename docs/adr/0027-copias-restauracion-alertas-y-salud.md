# ADR 0027: Copias en GitHub, restauración mensual automática, alertas por umbral y pantalla de salud

- Estado: aceptado
- Fecha: 2026-11-09
- Unidad: U7 Transversales

## Decisión

1. **Copias:** `pg_dump` cifrado (AES-256) como artefacto privado de GitHub, 30 días; independiente de Supabase y de Vercel. Con la variable de repositorio `BACKUP_REQUIRED=true` (antes de M2) falla si faltan secretos. El flujo anota cada copia en `backup_runs` si su rol puede escribir; si no, avisa y el panel muestra «sin dato». **Riesgo aceptado:** la copia depende de la cuenta de GitHub y de la frase de paso (guardada también en el gestor de contraseñas); fotos y etiquetas no están en la copia.
2. **Restauración:** `restore-test.yml` mensual restaura la última copia en un Postgres efímero y ejecuta `scripts/db/verify-restore.mjs` (tablas, filas, conservación del libro por pedido, saldos derivados, pedidos sin artista). El CI repite la cadena completa (volcado → cifrado → descifrado → restauración → comprobación) con una base de pruebas y comprueba que el verificador **detecta** un libro descuadrado.
3. **Alertas de seguridad:** trabajo cada 5 minutos con dos agregados indexados; umbrales 10 / 10 / 5 por hora (`ALERT_*`); un aviso por tipo y franja deduplicado con los propios eventos `operator_alert` de la auditoría; aviso por correo al operador (`operator_notice`). Los bloqueos del operador ya se avisan al producirse (U6).
4. **Auditoría:** de solo inserción para la aplicación y **sin limpieza en el v0** (sin datos personales; mínimo 90 días garantizado). Aviso `auditoria_voluminosa` al superar 1.000.000 de filas, momento en que se decide una limpieza con un rol aparte.
5. **Salud:** `/operador/salud` (solo lectura, TOTP) con secciones independientes y estado puro y monótono; monitor externo gratuito sobre `/api/health`; métricas de latencia y errores en el panel de Vercel; las cuotas se muestran como recordatorio con fecha de revisión (35 días) porque no se pueden medir automáticamente.

## Consecuencias

Las cuotas dependen de una revisión manual mensual. El estado de los circuitos es el de la instancia que sirve la página. Si crece el volumen o el dinero, se añade una segunda copia fuera de GitHub sin rehacer nada.
