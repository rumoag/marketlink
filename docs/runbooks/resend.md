# Runbook: Resend (correo transaccional)

Estado: **pendiente de ejecutar**.

## 1. Cuenta, dominio y clave

1. Crea la cuenta en Resend y una clave de **solo envío** (`RESEND_API_KEY`, por entorno).
2. Verifica el dominio de envío con SPF, DKIM y DMARC (sin dominio verificado Resend **solo entrega al titular de la cuenta**).
3. Define `EMAIL_FROM` (por ejemplo `avisos@<dominio>`) y `OPERATOR_EMAIL` (destino de los avisos al operador).
4. Desactiva el rastreo de aperturas y de clics en la configuración del dominio (los correos van en texto plano).

## 2. Fuera de producción

`EMAIL_SANDBOX_REDIRECT` es obligatoria en sandbox: todos los correos van a esa dirección con el asunto `[PRUEBA]`. En `live` se ignora. Comprueba que la aplicación se niega a arrancar en sandbox sin ella.

## 3. Comprobación manual obligatoria

1. Con un pedido de prueba, verifica que llegan: pedido nuevo (artista), confirmación (compradora), «Paga el envío» (operador), etiqueta lista, «en camino» y entregado.
2. Comprueba que ninguno contiene calle ni teléfono y que llegan fuera de la carpeta de correo no deseado.
3. Apaga la clave (o usa una inválida): las notificaciones quedan `pendiente`, se reintentan y, agotados los intentos, quedan `fallida` con aviso `email_fallido` y mensaje en el pedido de la artista.
4. Anota la fecha y el resultado en `docs/quotas.md` (límites reales de envío).
