# Runbook: Packlink PRO (cotización)

Estado: **pendiente de ejecutar**. En U3 solo se cotiza (`GET /v1/services`, solo lectura, sin coste).

## 1. Clave

`PACKLINK_API_KEY` en Vercel: misma cuenta en sandbox y producción, como secreto distinto por entorno para poder rotarlas por separado.

## 2. Comprobación

1. Ejecuta el spike de U0 (`npm run spike:packlink`) y confirma el formato real de la respuesta: `id`, `carrier_name`, `name`, `price.total_price` (euros), `transit_hours` y `dropoff`.
2. Confirma qué significa `dropoff` para cada servicio: el adaptador asume `true` = la artista deja el paquete en un punto (`punto`) y `false` = recogida en su domicilio (`recogida`). Si no es así, corrige `parseService` en `packlink-shipping-adapter.ts` y anótalo en el ADR 0017.
3. Cotiza Madrid → Barcelona con el tamaño M (50×40×10 cm, 2 kg) y comprueba que hay servicios de ambas modalidades.
4. Con una clave inválida el comprador debe ver «No podemos calcular el envío» y el contador de avisos subir.

## 3. Cuota

Sin caché: cada cotización es una llamada. Límites: 20 cotizaciones cada 10 minutos por IP. Anota en `quotas.md` el límite real de peticiones de la API.
