# ADR 0020: Etiquetas en almacenamiento privado con URL corta y factura borrador con `pdf-lib`

- Estado: aceptado
- Fecha: 2026-11-06
- Unidad: U4 Envío y seguimiento

## Decisión

1. **Etiqueta:** PDF descargado de Packlink solo por HTTPS desde `*.packlink.com` (defensa SSRF), validado (cabecera `%PDF`, ≤ 2 MB) y guardado en el bucket privado `labels` con clave opaca. No se adjunta a ningún correo.
2. **Entrega:** ruta con sesión `GET /artista/pedidos/{id}/etiqueta` → comprobación explícita de que el pedido es de la artista → redirección 302 a una URL firmada de 5 minutos → auditoría `label_downloaded`. Pedido ajeno e inexistente dan 404 idéntico.
3. **Retención:** 30 días después de `entregado` (90 días si nunca se entrega); las notificaciones, 12 meses. Limpieza diaria idempotente con auditoría.
4. **Las etiquetas no entran en la copia de seguridad** (se vuelven a pedir a Packlink): riesgo aceptado.
5. **Factura borrador:** `pdf-lib` 1.17.1 (MIT, JavaScript puro, sin dependencias de producción) genera a demanda un PDF de una página con la marca «BORRADOR – no válido como factura» y «NIF: pendiente de completar»; no se guarda. La dirección fiscal y el NIF se resuelven con el asesor en U7.

## Riesgos

`pdf-lib` no recibe versiones desde 2021; es estable y de ámbito muy acotado (generar un PDF simple). Si apareciera una vulnerabilidad, el generador está aislado tras `InvoiceRenderer` y es sustituible.
