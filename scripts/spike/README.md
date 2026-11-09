# Spike U0 — Packlink y Stripe

Scripts desechables para resolver las incógnitas técnicas antes de construir U3, U4 y U5. No contienen lógica de negocio. Requieren Node 24 o superior y no tienen dependencias.

## Preparación

1. Copia `.env.example` como `.env` (en `marketlink/`) y rellena **tú** los valores:
   - `PACKLINK_API_KEY`: Packlink PRO > Configuración > Clave API.
   - `STRIPE_SECRET_KEY`: clave secreta **de prueba** (`sk_test_...`). El script se niega a usar una clave real.
   - Opcionales: códigos postales y ciudades de prueba, `SPIKE_EMAIL`, `SPIKE_WEBHOOK_URL`, `STRIPE_API_VERSION`.
2. No pegues las claves en el chat ni en Git. `.env` está ignorado.
3. Comprueba las utilidades: `npm run test:spike`.

Los resultados se guardan en `scripts/spike/out/` (ignorado por Git). Salen redactados: sin claves y sin datos personales. Compártelos conmigo, no tus claves.

## Packlink (preguntas P1 a P4)

Ejecuta en este orden desde `marketlink/`:

```bash
node scripts/spike/spike-packlink.mjs --check
node scripts/spike/spike-packlink.mjs --quote
```

- `--check` comprueba la autenticación (`Authorization: <clave>`) y cuántos paquetes y direcciones tiene tu cuenta.
- `--quote` cotiza S, M y L entre tus códigos postales de prueba e imprime el servicio más barato de punto (`dropoff=true`) y de recogida (`dropoff=false`), la diferencia, la forma real del precio y el formato de `available_dates`.

Si `--check` y `--quote` funcionan, ya tienes la mayor parte de la respuesta. Las dos siguientes **modifican tu cuenta** y exigen `--confirm`:

```bash
# Crea un borrador SIN pagar. Bórralo después desde el panel de Packlink.
node scripts/spike/spike-packlink.mjs --draft --modality=punto --confirm
```

```bash
# Registra una integración. En el plan Free solo hay una conexión: cada intento exitoso la ocupa.
node scripts/spike/spike-packlink.mjs --register --type=VALOR --confirm
node scripts/spike/spike-packlink.mjs --unregister --id=ID_DEL_RESULTADO --confirm
```

Para `--register` hace falta `SPIKE_WEBHOOK_URL` (una URL https pública) y un `--type`. No sé qué valores acepta Packlink: pruébalos de uno en uno (por ejemplo `API`, `CUSTOM`) y bórralos con `--unregister` si no te sirven. Si la respuesta lista los valores válidos, será suficiente un intento.

## Stripe, solo en modo test (preguntas P5 a P7)

```bash
node scripts/spike/spike-stripe.mjs --preflight
node scripts/spike/spike-stripe.mjs --bizum
node scripts/spike/spike-stripe.mjs --account
```

- `--bizum` intenta crear una sesión de Checkout con Bizum como cargo en la plataforma. El mensaje de error, si lo hay, dice si Bizum está disponible en tu cuenta. Si Stripe no reconoce `bizum`, vuelve a probar con `STRIPE_API_VERSION=2026-05-27.dahlia` en `.env`.
- `--account` crea una cuenta Express de prueba y muestra un enlace de onboarding. Ábrelo en el navegador y complétalo con los datos de prueba de Stripe. Después vuelve a ejecutar `--account` para ver el estado.

Con la cuenta lista:

```bash
node scripts/spike/spike-stripe.mjs --bizum            # repite: ahora incluye un destination charge
node scripts/spike/spike-stripe.mjs --charge
node scripts/spike/spike-stripe.mjs --transfer
node scripts/spike/spike-stripe.mjs --balance
node scripts/spike/spike-stripe.mjs --payout-schedule
node scripts/spike/spike-stripe.mjs --payout
```

- `--charge` crea un cargo de 20 € en la plataforma con una tarjeta de prueba cuyo saldo queda disponible al instante.
- `--transfer` transfiere 15 € a la cuenta Express con `source_transaction`.
- `--payout-schedule` pone el calendario de pagos en manual; `--payout` lanza un pago de 10 € al banco por API. Si Stripe lo rechaza, el error indica por qué (por ejemplo, falta cuenta bancaria de prueba en el onboarding).

## Qué compartir conmigo

Los archivos de `scripts/spike/out/`: `packlink-check.json`, `packlink-quote.json`, `packlink-draft-*.json`, `packlink-register.json`, `stripe-bizum.json` y `stripe-state.json`. Con ellos escribo el ADR 0007 y ajusto U3 a U5.

## Seguridad

- Ningún script paga una etiqueta ni mueve dinero real.
- Las claves solo se leen de `.env`, nunca se imprimen ni se guardan.
- Todas las llamadas tienen un tiempo de espera de 15 s.
