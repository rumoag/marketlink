# Procedimiento de incidencias

Una incidencia es cualquier alerta, fallo o sospecha que afecte al dinero, a los datos personales o a la disponibilidad.

## Pasos

1. **Detección.** Llega por una alerta del sistema (correo o panel de salud), por el monitor externo o por una persona. Anota la hora y qué viste.
2. **Contención.** Frena el daño antes de investigar:
   - Dinero: parar `retry_settlements` y poner `PAYOUT_MODE=automatico` (ver `dinero.md`).
   - Panel: vaciar `OPERATOR_EMAILS` o rotar `OPERATOR_SESSION_SECRET` (ver `operador-acceso.md`).
   - Secretos: rotarlos (ver `rotacion-secretos.md`).
   - Versión mala: promover el despliegue anterior en Vercel (ver `rollback.md`).
3. **Resolución.** Corrige la causa, comprueba en el panel de salud que vuelve a verde y reanuda lo que paraste.
4. **Revisión posterior** en 5 días laborables: causa, línea de tiempo, qué funcionó, acción preventiva y fecha. Se anota en `docs/resilience/registro.md` (sección de incidentes).

## Por dónde empieza cada alerta

| Alerta                                                                                          | Primer paso                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seguridad_autenticacion` (≥ 10 fallos de acceso/h)                                             | Revisar `auth_failure` en la auditoría (¿una IP? ¿un email?); si es ataque, no hace falta más: los límites de tasa ya frenan; si dudas, rotar `SESSION_COOKIE_SECRET` |
| `seguridad_autorizacion` (≥ 10 denegaciones/h)                                                  | Revisar `authz_denied`: ¿rutas probadas o un fallo de la aplicación? Si hay un recurso concreto, mirar su ficha                                                       |
| `seguridad_webhook` (≥ 5 firmas inválidas/h)                                                    | Comprobar los secretos de los webhooks (Stripe, Packlink); puede ser un secreto rotado a medias o alguien probando el endpoint                                        |
| `acceso_operador_bloqueado`                                                                     | Comprobar si fuiste tú; si no, rotar `OPERATOR_SESSION_SECRET` y tu secreto TOTP                                                                                      |
| `auditoria_voluminosa`                                                                          | Decidir la limpieza de la auditoría (ADR 0027)                                                                                                                        |
| `limpieza_datos_fallida`                                                                        | Mirar los trabajos fallidos de `purge_personal_data`; reintentar al día siguiente                                                                                     |
| `conciliacion_desajuste`, `liquidacion_*`, `retirada_fallida`, `disputa_abierta`, `reembolso_*` | Ver `dinero.md`                                                                                                                                                       |
| `packlink_*`, `etiqueta_no_descargada`, `incidencia_envio`, `borrador_sin_pagar`                | Ver `packlink-envios.md`                                                                                                                                              |
| `email_fallido`                                                                                 | Ver `resend.md`                                                                                                                                                       |
| Monitor externo en rojo                                                                         | Abrir `/api/health`; si no responde, mirar el estado de Vercel y el último despliegue (`rollback.md`)                                                                 |
| Copia fallida o restauración de prueba fallida                                                  | Ver `restauracion.md`; no esperes al siguiente día: la copia es tu red de seguridad                                                                                   |
