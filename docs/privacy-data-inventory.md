# Inventario de datos personales (U2-NFR-PR3)

Qué datos personales guarda U2, dónde, para qué y quién puede verlos. Se amplía en cada unidad. La base legal, los plazos de conservación definitivos y los procedimientos de acceso, rectificación y supresión se cierran con la revisión fiscal y legal de U7 (RGPD). Hasta entonces, **los datos se conservan mientras exista la cuenta** y cualquier petición de exportación o borrado la atiende a mano el operador.

| Dato                                           | Tabla o servicio                          | Finalidad                                           | Quién lo ve                                                     | En logs                   |
| ---------------------------------------------- | ----------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- | ------------------------- |
| Correo electrónico                             | `artists.email`; Supabase Auth            | Entrar sin contraseña y contactar                   | El propio artista y el operador                                 | No (se enmascara)         |
| Nombre artístico                               | `artists.artistic_name`                   | Identificar al artista                              | **El comprador** (página del enlace), el artista y el operador  | No necesario              |
| Usuario de Instagram                           | `artists.instagram`                       | Dar confianza al comprador                          | **El comprador**, el artista y el operador                      | No necesario              |
| Teléfono                                       | `artists.phone`, `sender_addresses.phone` | Contacto del operador y de la empresa de transporte | El propio artista y el operador; nunca el comprador             | No (se redacta)           |
| Dirección de remitente                         | `sender_addresses`                        | Origen de cotizaciones, borradores y recogidas      | El propio artista, el operador y el transportista (U4)          | No (se redacta)           |
| Identificador de cuenta de cobros              | `payout_accounts.provider_account_id`     | Operar con Stripe                                   | Solo el servidor; nunca en respuestas ni logs                   | No (se redacta)           |
| Estado de cobros                               | `payout_accounts.status`                  | Permitir crear enlaces                              | El propio artista y el operador                                 | Sí (sin datos personales) |
| Fotos de las obras                             | Storage privado (`listing-images`)        | Mostrar la obra                                     | El comprador (URL firmada de 1 h solo si el enlace está activo) | No                        |
| Datos del enlace (título, descripción, precio) | `listings`                                | Vender la obra                                      | El comprador (si está activo), el artista y el operador         | Solo identificadores      |
| Sesión (cookies `ml_at`, `ml_rt`, `ml_act`)    | Navegador del artista                     | Mantener la sesión                                  | Nadie más; `HttpOnly`                                           | No                        |
| Eventos de seguridad                           | `audit_events` (y copia en logs)          | Detectar abusos (SECURITY-13)                       | Operador                                                        | Sin datos personales      |

## Principios aplicados

- **Minimización:** el comprador solo ve nombre artístico, Instagram y la obra. Nunca teléfono, correo ni dirección.
- **Fotos sin ubicación:** se eliminan todos los metadatos (incluido el GPS) al procesarlas.
- **Sin datos personales en URLs:** los identificadores son UUID y el slug es aleatorio.
- **Sin datos personales en logs, `payload` de trabajos ni `audit_events`:** pasan por el redactor.
- **Aislamiento:** políticas RLS por artista; el rol de la aplicación no puede borrar enlaces ni modificar la auditoría.

## Datos de la compradora (U3)

| Dato                                                      | Dónde                    | Finalidad                                           | Plazo                                                                               |
| --------------------------------------------------------- | ------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Nombre, email, teléfono                                   | `orders.buyer`           | Gestionar la compra, el recibo de Stripe y el envío | Cancelados y expirados: 30 días. Completados: 24 meses y después se anonimizan (U7) |
| Calle, complemento, código postal, localidad, provincia   | `orders.destination`     | Entrega del paquete                                 | Igual                                                                               |
| Aceptación de privacidad y condiciones (versión y fecha)  | `orders.consent`         | Demostrar el consentimiento                         | Con el pedido                                                                       |
| Importes y fechas                                         | `orders`, `order_events` | Contabilidad                                        | 6 años                                                                              |
| Identificador de la cookie de reintento (solo su resumen) | `orders.resume_hash`     | Rellenar el formulario tras cancelar                | 1 hora                                                                              |
| Teléfono de Bizum de la artista (opcional)                | `artists.bizum_phone`    | Cobro manual                                        | Mientras exista la cuenta                                                           |

Nunca aparecen en URLs, logs, trabajos, `order_events`, `audit_events` ni metadatos de Stripe.

### Envío y avisos (U4)

| Dato                                                 | Dónde                                 | Finalidad                        | Plazo                                             |
| ---------------------------------------------------- | ------------------------------------- | -------------------------------- | ------------------------------------------------- |
| Etiqueta PDF (nombre y dirección del destinatario)   | Bucket privado `labels`               | Que la artista envíe el paquete  | 30 días tras `entregado` (90 si nunca se entrega) |
| Nombre, dirección, teléfono y email del destinatario | Packlink (transportista)              | Entrega del paquete              | Según Packlink; solo en el borrador               |
| Tipo, estado y pedido de cada aviso                  | `notifications` (sin cuerpo ni email) | Reintentos y panel de la artista | 12 meses                                          |
| Dirección completa de la compradora                  | Página del pedido de la artista       | Preparar el envío                | Solo entre `borrador_creado` y `en_transito`      |

Los emails van en texto plano, sin calle ni teléfono, y fuera de producción se redirigen a una dirección de pruebas. Quien los ve: el operador, la artista implicada (solo la localidad hasta U4), el transportista y Stripe (email para el recibo).

## Pendiente (U7)

Base legal y aviso de privacidad, plazos de conservación, procedimiento de supresión y exportación, registro de actividades de tratamiento, encargados del tratamiento (Supabase, Vercel, Stripe, Resend) y transferencias internacionales.

## U5 Dinero

| Dato                                                                            | Dónde                                                                        | Finalidad                                    | Plazo                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| Movimientos de dinero (importes, referencias opacas de Stripe, identificadores) | `ledger_entries`, `artist_balances`, `settlements`, `withdrawals`, `refunds` | Contabilidad, saldos y obligaciones fiscales | 6 años; no entran en la limpieza de privacidad |
| Exportación mensual (sin datos personales)                                      | Bucket privado `finance-exports`                                             | Entregar los importes al contable            | 6 años                                         |
| Importe de una retirada                                                         | `notifications.amount_cents`                                                 | Avisar a la artista                          | 12 meses                                       |

Ninguna de estas tablas guarda nombre, email, teléfono ni dirección de nadie.

## U6 Panel del operador

| Dato                                                                 | Dónde                           | Finalidad              | Plazo                                                  |
| -------------------------------------------------------------------- | ------------------------------- | ---------------------- | ------------------------------------------------------ |
| Email del operador y estado del segundo factor (último paso, fallos) | `operator_totp_state`           | Seguridad del acceso   | Mientras sea operador                                  |
| Incidencias y notas internas (sin datos personales de la compradora) | `order_flags`, `operator_notes` | Control de lo ocurrido | 6 años                                                 |
| Visitas por obra y día (sin IP, cookie ni identificador)             | `listing_views`                 | Métricas de validación | 24 meses                                               |
| Dirección y contacto de la compradora (solo se muestran)             | Ficha del pedido del operador   | Resolver incidencias   | Mientras existan en el pedido; cada consulta se audita |

Los secretos TOTP viven solo en variables de entorno y en la aplicación de autenticación del operador; no se guardan en base de datos.

## U7 Transversales

| Dato                                           | Dónde                                          | Finalidad                                 | Plazo                                                                        |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| Datos personales de la compradora en el pedido | `orders` (nombre, correo, teléfono, dirección) | Preparar el envío y atender reclamaciones | **12 meses desde la entrega** (o el pago); borrado a petición desde el panel |
| Registro de copias (fecha, tamaño, huella)     | `backup_runs`                                  | Mostrar la última copia en la salud       | Indefinido (sin datos personales)                                            |
| Copias de la base                              | Artefactos privados de GitHub, cifradas        | Recuperación (RPO 24 h)                   | 30 días                                                                      |
| Auditoría (sin datos personales)               | `audit_events`                                 | Seguridad y reconstrucción de incidentes  | Sin limpieza en el v0; mínimo 90 días                                        |

La dirección de contacto para ejercer derechos es `CONTACT_EMAIL`. Las copias contienen datos personales cifrados: quien tenga la frase de paso puede abrirlas, por eso se guarda solo en GitHub Secrets y en el gestor de contraseñas del operador.
