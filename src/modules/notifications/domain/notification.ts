import type { Instant } from '@/modules/kernel/domain/clock';
import { Money } from '@/modules/kernel/domain/money';

/** Tipos de aviso (BR4-NT*). Una notificacion de cada tipo por pedido (indice unico). */
export const NOTIFICATION_TYPES = [
  'pedido_nuevo_artista',
  'confirmacion_compradora',
  'paga_envio_operador',
  'elegir_recogida_artista',
  'recordatorio_recogida_artista',
  'recogida_sin_elegir_operador',
  'etiqueta_lista_artista',
  'en_camino_compradora',
  'entregado_compradora',
  'entregado_artista',
  'incidencia_artista',
  'incidencia_compradora',
  'incidencia_operador',
  'recordatorio_pago_envio_operador',
  // U5
  'liquidacion_artista',
  'retirada_artista',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type RecipientRole = 'artista' | 'compradora' | 'operador';
export type NotificationStatus = 'pendiente' | 'enviada' | 'fallida';

/** Rol que recibe cada tipo (P-U4-07). */
export const recipientOf = (type: NotificationType): RecipientRole => {
  if (type.endsWith('_artista')) return 'artista';
  if (type.endsWith('_compradora')) return 'compradora';
  return 'operador';
};

/** Notificacion de la bandeja: sin cuerpo ni direccion de email (se resuelven al enviar). */
export type Notification = {
  readonly id: string;
  /** Nulo en los avisos que no pertenecen a un pedido (retirada). */
  readonly orderId: string | undefined;
  /** Referencia unica del aviso cuando no hay pedido. */
  readonly dedupeRef?: string | undefined;
  /** Importe del aviso de dinero (retirada); sin datos personales. */
  readonly amountCents?: number | undefined;
  readonly artistId: string;
  readonly type: NotificationType;
  readonly recipientRole: RecipientRole;
  readonly status: NotificationStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Instant;
  readonly lastError: string | undefined;
  readonly createdAt: Instant;
  readonly sentAt: Instant | undefined;
};

/** Intentos antes de dar un email por perdido (despues de ellos queda `fallida`). */
export const MAX_NOTIFICATION_ATTEMPTS = 6;

/** Esperas entre intentos de envio (retroceso). */
export const notificationBackoffMs = (attempts: number): number =>
  [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000][Math.min(attempts, 5) - 1] ?? 43_200_000;

// ---------------------------------------------------------------------------------------------
// Plantillas (texto plano, espanol, sin imagenes ni rastreo; BR4-NT4)
// ---------------------------------------------------------------------------------------------
export type DropoffLine = {
  readonly name: string;
  readonly address: string;
  readonly schedule: string;
};

export type EmailContext = {
  readonly brand: string;
  readonly orderRef: string;
  readonly title: string;
  readonly totalCents: number;
  readonly shippingCents: number;
  readonly orderUrl: string;
  readonly trackingUrl: string | undefined;
  readonly carrier: string | undefined;
  readonly modality: 'punto' | 'recogida';
  readonly pickupText: string | undefined;
  readonly dropoffs: readonly DropoffLine[];
  readonly labelCostCents: number | undefined;
  /** U5: importe del aviso de dinero (liquidacion o retirada). */
  readonly amountCents?: number | undefined;
};

export type RenderedEmail = { readonly subject: string; readonly text: string };

const eur = (cents: number): string => Money.format({ cents, currency: 'EUR' });

const sign = (c: EmailContext): string => `\n\n— ${c.brand}`;

/** Texto de cada aviso. Nunca incluye calle, telefono ni nombre de nadie (P-U4-08). */
export const renderEmail = (type: NotificationType, c: EmailContext): RenderedEmail => {
  const ref = `Pedido ${c.orderRef}`;
  switch (type) {
    case 'pedido_nuevo_artista':
      return {
        subject: `Has vendido «${c.title}»`,
        text: `Hola,\n\n¡Enhorabuena! Has vendido «${c.title}» por ${eur(c.totalCents - c.shippingCents)} (el envío lo gestionamos nosotros).\n\nSiguiente paso: estamos preparando la etiqueta de envío. Te avisaremos cuando esté lista. Puedes ver el pedido aquí:\n${c.orderUrl}${sign(c)}`,
      };
    case 'confirmacion_compradora':
      return {
        subject: 'Hemos recibido tu pago',
        text: `Hola,\n\nPago recibido. Te avisaremos cuando salga el envío de «${c.title}» (${eur(c.totalCents)}).\n\nPuedes consultar tu pedido en cualquier momento:\n${c.trackingUrl ?? ''}${sign(c)}`,
      };
    case 'paga_envio_operador':
      return {
        subject: `Paga el envío ${c.orderRef}`,
        text: `${ref}: hay un borrador de envío pendiente de pago en Packlink.\nTransportista: ${c.carrier ?? 'sin indicar'}.\nPrecio cobrado por el envío: ${eur(c.shippingCents)}.\n\nPágalo en Packlink PRO y la etiqueta llegará sola.`,
      };
    case 'recordatorio_pago_envio_operador':
      return {
        subject: `Recordatorio: paga el envío ${c.orderRef}`,
        text: `${ref}: el borrador de envío lleva más de 24 horas sin pagar en Packlink. Paga la etiqueta para que la artista pueda enviar la obra.`,
      };
    case 'elegir_recogida_artista':
      return {
        subject: `Elige cuándo recogen «${c.title}»`,
        text: `Hola,\n\nTu obra «${c.title}» se ha vendido. Elige la fecha y la franja de recogida aquí:\n${c.orderUrl}${sign(c)}`,
      };
    case 'recordatorio_recogida_artista':
      return {
        subject: `Recordatorio: elige la recogida de «${c.title}»`,
        text: `Hola,\n\nAún no has elegido la fecha de recogida de «${c.title}». Hazlo aquí:\n${c.orderUrl}${sign(c)}`,
      };
    case 'recogida_sin_elegir_operador':
      return {
        subject: `Recogida sin elegir ${c.orderRef}`,
        text: `${ref}: la artista lleva más de 72 horas sin elegir la fecha de recogida.`,
      };
    case 'etiqueta_lista_artista': {
      const where =
        c.modality === 'punto'
          ? c.dropoffs.length > 0
            ? `Lleva el paquete a uno de estos puntos:\n${c.dropoffs.map((d) => `- ${d.name}, ${d.address} (${d.schedule})`).join('\n')}`
            : 'Lleva el paquete a un punto de entrega de tu transportista (búscalo en su web).'
          : `Recogida: ${c.pickupText ?? 'la fecha que elegiste'}. Ten el paquete preparado.`;
      return {
        subject: `Tu etiqueta de «${c.title}» está lista`,
        text: `Hola,\n\nLa etiqueta de «${c.title}» está lista. Descárgala e imprímela desde tu pedido (necesitas iniciar sesión):\n${c.orderUrl}\n\n${where}${sign(c)}`,
      };
    }
    case 'en_camino_compradora':
      return {
        subject: 'Tu obra está en camino',
        text: `Hola,\n\n«${c.title}» ya está en manos del transportista${c.carrier ? ` (${c.carrier})` : ''}.\n\nSigue tu pedido aquí:\n${c.trackingUrl ?? ''}${sign(c)}`,
      };
    case 'entregado_compradora':
      return {
        subject: 'Tu obra ha sido entregada',
        text: `Hola,\n\nEl transportista indica que «${c.title}» se ha entregado. ¡Que la disfrutes!\n${c.trackingUrl ?? ''}${sign(c)}`,
      };
    case 'entregado_artista':
      return {
        subject: `Entregada «${c.title}»`,
        text: `Hola,\n\nLa obra «${c.title}» se ha entregado a su destino. Puedes ver el pedido aquí:\n${c.orderUrl}${sign(c)}`,
      };
    case 'incidencia_artista':
      return {
        subject: `Estamos revisando el envío de «${c.title}»`,
        text: `Hola,\n\nHa habido un problema con el envío de «${c.title}». Lo estamos revisando y te avisaremos; no tienes que hacer nada por ahora.\n${c.orderUrl}${sign(c)}`,
      };
    case 'incidencia_compradora':
      return {
        subject: 'Estamos revisando tu envío',
        text: `Hola,\n\nHa habido un problema con el envío de «${c.title}». Lo estamos revisando y te avisaremos; tu compra está a salvo.\n${c.trackingUrl ?? ''}${sign(c)}`,
      };
    case 'liquidacion_artista':
      return {
        subject: `Cobro de «${c.title}» disponible`,
        text: `Hola,\n\nLa obra «${c.title}» se ha entregado y ${eur(c.amountCents ?? 0)} ya están disponibles en tu saldo. Puedes verlo y retirarlo aquí:\n${c.orderUrl}${sign(c)}`,
      };
    case 'retirada_artista':
      return {
        subject: 'Hemos iniciado tu retirada',
        text: `Hola,\n\nHemos iniciado la retirada de ${eur(c.amountCents ?? 0)} a tu cuenta bancaria. Suele tardar uno o dos días laborables. Si no fuiste tú, avísanos cuanto antes.\n${c.orderUrl}${sign(c)}`,
      };
    case 'incidencia_operador':
      return {
        subject: `Incidencia de envío ${c.orderRef}`,
        text: `${ref}: Packlink o el transportista han notificado un fallo del envío. Revísalo en el panel.`,
      };
  }
};
