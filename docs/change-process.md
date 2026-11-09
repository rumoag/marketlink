# Proceso ligero de cambios (RESILIENCY-03)

Todo cambio que llegue a producción pasa por un PR con la plantilla `.github/PULL_REQUEST_TEMPLATE.md`.

1. **Registro:** el PR describe qué cambia, el riesgo (bajo, medio, alto) y si incluye migración.
2. **Aprobación:** la da quien opera el producto. Con un solo desarrollador, el PR queda como registro y la CI verde es la condición.
3. **Nota de rollback obligatoria:** cómo se deshace (promover el despliegue anterior, migración hacia delante, desactivar un flag). Ver `runbooks/rollback.md`.
4. **CI verde:** tipos, lint, formato, pruebas unitarias y de propiedades, integración, build, auditoría de dependencias de producción, escaneo de secretos y SBOM.
5. **Migraciones:** aditivas y compatibles hacia atrás. Sandbox se migra solo al fusionar; producción solo a mano y con aprobación del _environment_ `production`.
6. **Rama principal protegida:** PR obligatorio y CI verde antes de fusionar (configurar en los ajustes del repositorio).

## Incidencias (versión ligera)

Si algo falla en producción: restablecer el servicio (rollback o flag), anotar el incidente en `docs/resilience/registro.md` (qué pasó, duración, causa, acción preventiva) y abrir el PR de corrección con una prueba que lo reproduzca. El proceso completo de incidencias y comunicación se cierra en U7.

## U7: registro, aprobación y comprobación

Todo cambio en producción deja:

1. **Registro:** qué cambia, por qué, quién lo hace y cuándo (la descripción de la PR o del despliegue sirve).
2. **Aprobación:** del operador antes de desplegar (el CI en verde es condición, no sustituto).
3. **Nota de rollback:** cómo volver atrás (`rollback.md`); las migraciones son **aditivas y compatibles hacia atrás** (no se borran ni renombran columnas usadas por la versión anterior); si una migración no lo es, se divide en dos despliegues.
4. **Comprobación posterior:** `/api/health`, pantalla `/operador/salud` en verde o ámbar explicado y, si el cambio toca dinero, una operación de prueba.

Los cambios de secretos y de variables siguen el mismo registro (sin escribir los valores).
