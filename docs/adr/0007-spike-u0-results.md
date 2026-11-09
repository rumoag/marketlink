# ADR 0007 — Resultados del spike U0

- **Estado:** pendiente de resultados
- **Fecha:** (se rellena al recibir los resultados)
- **Relacionados:** ADR-001 (Packlink), ADR-002 (Stripe Connect), ADR-003 (flujo de dinero), ADR-006 (pago manual)

## Contexto

Hay incógnitas técnicas sobre Packlink y Stripe que condicionan U3 (compra y pago), U4 (envío y seguimiento) y U5 (dinero).

## Resultados y decisiones

| #   | Pregunta                                                                                 | Resultado   | Decisión según el resultado                                                                           |
| --- | ---------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| P1  | ¿Autentica `Authorization: <clave>` y qué devuelve `GET clients`?                        | _pendiente_ | Si falla: revisar la forma de autenticar antes de seguir                                              |
| P2  | ¿Hay servicios de punto y recogida? ¿Formato del precio? ¿Diferencia de precio?          | _pendiente_ | Fija `priceOf` del adaptador y el cálculo de margen                                                   |
| P3  | ¿Se puede registrar una integración propia en el plan Free? ¿Con qué `integration_type`? | _pendiente_ | Si no: valorar un plan de Packlink superior, otro proveedor tras `ShippingProvider` o modo semimanual |
| P4  | ¿Se puede crear un borrador sin pagarlo?                                                 | _pendiente_ | Si no: replantear el flujo de humano en el bucle (ADR-001)                                            |
| P5  | ¿Acepta Stripe Bizum con cargo en la plataforma? ¿Y con destination charge?              | _pendiente_ | Si no con cargo en plataforma: tarjeta primero y modo manual para Bizum (ADR-006)                     |
| P6  | ¿Funciona el cargo en plataforma y la transferencia con `source_transaction` a Express?  | _pendiente_ | Si no: reconsiderar retención hasta entrega (ADR-003)                                                 |
| P7  | ¿Se puede poner el calendario manual en Express y lanzar un pago por API?                | _pendiente_ | Si no: botón "Retirar" no viable; pago automático de Stripe                                           |

## Consecuencias

(Se escriben tras analizar los resultados: ajustes en U3, U4 y U5 y en los requisitos FR-26, FR-27 y NFR.)
