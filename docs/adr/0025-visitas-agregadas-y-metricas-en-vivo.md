# ADR 0025: Visitas agregadas sin identificadores y métricas calculadas al abrir la página

- Estado: aceptado
- Fecha: 2026-11-08
- Unidad: U6 Panel del operador

## Decisión

1. **Contador `listing_views(listing_id, day, count)`**, una fila por obra y día UTC, con `INSERT … ON CONFLICT DO UPDATE SET count = count + 1`. Sin IP, cookie ni identificador de visitante. Se registra con `after()` de Next.js (tras responder), en mejor esfuerzo y con fallo abierto.
2. **Qué cuenta:** peticiones con `User-Agent` que no sea un robot evidente (`bot`, `crawler`, `spider`, `preview`, `curl`, `headless`…), sin cabecera de precarga y sin sesión de artista. Límite laxo de 120 visitas por hora e IP anonimizada (sal existente) y obra: superado, no se cuenta pero la página se sirve. Límite documentado: una persona que recarga suma varias visitas (no hay visitantes únicos).
3. **Retención:** 24 meses (`purge_listing_views`, diario).
4. **Métricas en vivo:** consultas agregadas indexadas al abrir la página, para el periodo y el anterior, en paralelo; sin tabla de resumen. Porcentajes con aviso «pocos datos» bajo 5 pedidos.
5. **Método de pago (tarjeta / Bizum):** `orders.payment_method` se rellena al resolver el cargo (`MoneyProvider.chargeOf`, al liquidar). Hasta entonces el pedido cuenta en los totales pero no en el porcentaje de método.

## Consecuencias

La conversión se calcula como pedidos pagados / visitas y nunca supera el 100 %. Si más adelante hace falta rendimiento, se añade una tabla diaria de resumen sin cambiar la pantalla.
