# Runbook: restauración de la base de datos

Objetivo: RTO ≤ 8 h, RPO ≤ 24 h. Estado: **borrador, pendiente de ensayo** (escenario R-01 antes de M2 y después trimestralmente). Se completa en U7.

## Copias disponibles

- **Copia lógica diaria** (workflow _Copia de seguridad_): artefacto cifrado `marketlink.dump.gpg` con su suma `sha256`, retención de 30 días en GitHub.
- **Copias gestionadas de Supabase** (solo con plan de pago, desde M2).

## Restaurar en un proyecto de prueba (ensayo) o de recuperación

1. Descarga el artefacto del workflow (_Actions_ → ejecución → _Artifacts_).
2. Verifica la integridad: `sha256sum -c marketlink.dump.gpg.sha256`.
3. Descifra: `gpg --batch --pinentry-mode loopback --passphrase "<BACKUP_PASSPHRASE>" --output marketlink.dump --decrypt marketlink.dump.gpg`.
4. Crea una base vacía en un proyecto de Supabase de prueba (nunca restaures sobre producción sin haberla aislado antes).
5. Aplica las migraciones (workflow _Migraciones_ o `supabase db push`) para que existan los roles.
6. Restaura: `pg_restore --no-owner --no-privileges --clean --if-exists --dbname "<url-propietario>" marketlink.dump`.
7. Reaplica privilegios si hiciera falta (`supabase db push` los vuelve a conceder: las migraciones son idempotentes).
8. Habilita el rol de la aplicación (`rotacion-secretos.md`) y apunta `DATABASE_URL` al proyecto restaurado.

## Verificación

- `GET /api/health/deep` devuelve `database: ok`.
- Recuento de filas de `jobs`, `audit_events` y `webhook_events` coherente con la fecha de la copia.
- Pruebas de integración contra la base restaurada: `TEST_DATABASE_URL=… npm run test:integration` **solo contra un proyecto de prueba** (borra el esquema `public`).
- Anota la hora de inicio y de fin: el tiempo total es el RTO medido.

## Registro

Apunta cada ensayo en `docs/resilience/registro.md`.

## U7: restauración de prueba automática y registro de copias

- **Mensual (`restore-test.yml`, también manual):** descarga la última copia correcta, comprueba la huella, descifra, restaura en un Postgres temporal y ejecuta `scripts/db/verify-restore.mjs`. Si falla, GitHub avisa: trátalo como una incidencia (`incident-process.md`).
- **En cada cambio (CI):** el trabajo «Copia y restauración» repite la cadena con una base de pruebas y comprueba que el verificador detecta un libro descuadrado.
- **Antes de M2:** activa la variable de repositorio `BACKUP_REQUIRED=true` y lanza a mano `backup.yml` y `restore-test.yml`; comprueba en `/operador/salud` que aparece la fecha de la última copia (si dice «sin dato», el rol de `BACKUP_DATABASE_URL` no puede escribir `backup_runs`: dale permiso de inserción solo sobre esa tabla).
- **Guarda la frase de paso** (`BACKUP_PASSPHRASE`) también en tu gestor de contraseñas: sin ella la copia no se abre.
- **Qué no está en la copia:** fotos de las obras (bucket) y etiquetas; las fotos las puede resubir la artista y las etiquetas se piden de nuevo a Packlink.
