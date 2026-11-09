# Riesgos fiscales y regulatorios (para el asesor)

**Estado:** borrador técnico. **No es asesoramiento legal.** La consulta con un asesor fiscal y regulatorio es **requisito de entrada a M2** (EN-16). Este documento describe qué hace el producto para que el asesor opine sobre algo exacto.

## Qué hace el producto

1. Una artista vende una obra original a una compradora (Instagram → enlace → pago con tarjeta o Bizum).
2. **La plataforma cobra el total** (obra + envío) con Stripe, **retiene** la parte de la artista hasta la entrega y se la **transfiere** (liquidación) a su cuenta de Stripe Connect Express; la artista la retira a su banco.
3. **La plataforma conserva el envío**, compra la etiqueta en Packlink PRO a su nombre y la entrega a la artista; el margen (cobrado − etiqueta − comisión de Stripe) es de la plataforma (puede ser negativo).
4. Comisión de la plataforma sobre la obra: 0 € en el v0.
5. Datos personales de la compradora: nombre, correo, teléfono y dirección, 12 meses desde la entrega.

## Riesgos y preguntas

| #   | Riesgo                                                                               | Situación actual                                                                                 | Pregunta para el asesor                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Cobro por cuenta de terceros y retención de fondos** (¿servicio de pago regulado?) | Los fondos se cobran con Stripe en la cuenta de la plataforma y se transfieren tras la entrega   | ¿Basta con el modelo de Stripe Connect (la entidad de pagos es Stripe) o la retención hasta la entrega exige otra figura?                                             |
| 2   | **IVA** de la venta de obras de arte y del envío                                     | La plataforma no emite factura de la obra; la factura del envío es un borrador                   | ¿Quién factura qué (obra y envío)? ¿La artista emite factura a la compradora? ¿Qué IVA lleva la obra original y el envío?                                             |
| 3   | **Reventa del envío** (la plataforma compra el transporte y lo cobra)                | El margen del envío es de la plataforma                                                          | ¿Se considera intermediación de transporte? ¿Con qué IVA y obligaciones?                                                                                              |
| 4   | **Obligaciones de información** (DAC7, plataformas digitales)                        | No se comunica nada a Hacienda                                                                   | ¿Aplica DAC7 a este modelo con pocas artistas? ¿Desde qué volumen?                                                                                                    |
| 5   | **Alta de las artistas** (autónomas, actividad ocasional, retenciones)               | La artista declara por su cuenta                                                                 | ¿Hay que advertirlo en las condiciones? ¿Hay retenciones o modelos a presentar por la plataforma?                                                                     |
| 6   | **Protección de datos** (RGPD): base legal, encargados, transferencias, derechos     | Aviso de privacidad en borrador; plazos de 12 meses y 30 días; borrado a petición desde el panel | Revisión del aviso y de las condiciones; ¿hace falta registro de actividades de tratamiento y contratos de encargado con Supabase, Vercel, Stripe, Resend y Packlink? |
| 7   | **Consumidores:** desistimiento, garantía y devoluciones de obras originales         | Condiciones de devolución pendientes                                                             | ¿Qué derecho de desistimiento aplica a obras únicas y cómo se refleja?                                                                                                |
| 8   | **Contabilidad:** conservación de 6 años y reparto de ingresos                       | El libro conserva los importes 6 años; exportación mensual a CSV                                 | ¿Qué necesita el asesor para llevar la contabilidad de la plataforma y de las retenciones?                                                                            |
| 9   | **Disputas y contracargos**                                                          | Aviso al operador; sin dinero que se mueva solo                                                  | ¿Quién asume un contracargo tras liquidar a la artista?                                                                                                               |
| 10  | **Bizum** con cargo en la plataforma                                                 | Pendiente de comprobar con Stripe (P5 del spike)                                                 | Si no funciona con el modelo de retención, ¿alternativa permitida?                                                                                                    |

## Cómo se usa

1. Revisa el estado real de cada punto en `docs/adr/0007-spike-u0-results.md` (Stripe y Packlink).
2. Llévalo a la consulta; anota aquí las decisiones del asesor y la fecha.
3. Ajusta los textos legales, las condiciones y la configuración según lo que diga.
4. Marca el hito: **consulta completada el ____ con ____**.

## Decisiones del asesor

| Fecha | Tema | Decisión | Cambio en el producto |
| ----- | ---- | -------- | --------------------- |
|       |      |          |                       |
