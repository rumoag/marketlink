import { createHmac, randomBytes } from 'node:crypto';
import { sha256Hex } from '@/modules/kernel/domain/hash';
import { deliverySummary, type DeliverySummary, type Order, type OrderStatus } from './order';

/**
 * Token de seguimiento (BR3-SG*, NFR-U3-17/18). 256 bits derivados con HMAC-SHA-256 de un secreto
 * del servidor, el pedido y un valor aleatorio. En base de datos solo se guarda su SHA-256; el
 * token se vuelve a derivar cuando hace falta mostrarlo (pagina de exito, email de U4).
 */
export type TrackingSecrets = { readonly current: string; readonly previous: string | undefined };

export const TOKEN_LENGTH = 43; // 32 bytes en base64url sin relleno
const WELL_FORMED = /^[A-Za-z0-9_-]{43}$/;

/** Huella corta del secreto (no lo revela): identifica con cual se derivo el token de un pedido. */
export const keyFingerprint = (secret: string): string => sha256Hex(`huella:${secret}`).slice(0, 8);

export const newTrackingNonce = (): string => randomBytes(16).toString('base64url');

export const deriveTrackingToken = (secret: string, orderId: string, nonce: string): string =>
  createHmac('sha256', secret)
    .update(`seguimiento:${orderId}:${nonce}`, 'utf8')
    .digest('base64url');

export const hashTrackingToken = (token: string): string => sha256Hex(token);

/** Forma valida: evita consultar la base con basura. Mal formado se trata como inexistente. */
export const isWellFormedToken = (raw: string): boolean => WELL_FORMED.test(raw);

/** Datos para crear un pedido: nonce, huella del secreto vigente, token y su resumen. */
export const issueTrackingToken = (
  secrets: TrackingSecrets,
  orderId: string,
  nonce: string = newTrackingNonce(),
): { nonce: string; keyId: string; hash: string } => ({
  nonce,
  keyId: keyFingerprint(secrets.current),
  hash: hashTrackingToken(deriveTrackingToken(secrets.current, orderId, nonce)),
});

/**
 * Vuelve a derivar el token de un pedido con el secreto con el que se emitio (vigente o anterior).
 * `undefined` si ese secreto ya se retiro: el enlace sigue funcionando si la compradora lo guardo,
 * pero ya no se puede volver a mostrar.
 */
export const tokenForOrder = (
  secrets: TrackingSecrets,
  order: Pick<Order, 'id' | 'trackingNonce' | 'tokenKeyId'>,
): string | undefined => {
  for (const secret of [secrets.current, secrets.previous]) {
    if (secret !== undefined && keyFingerprint(secret) === order.tokenKeyId) {
      return deriveTrackingToken(secret, order.id, order.trackingNonce);
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------------------------
// Vista de seguimiento (BR3-SG3, BR3-SG4): sin datos personales
// ---------------------------------------------------------------------------------------------
export type TrackingView = {
  readonly status: OrderStatus;
  readonly statusText: string;
  readonly title: string;
  readonly artisticName: string;
  readonly workPriceCents: number;
  readonly shippingCents: number;
  readonly totalCents: number;
  readonly createdAtMs: number;
  /** U8: como se entrega (US-064). El punto desaparece tras la purga. */
  readonly delivery: DeliverySummary;
};

export const trackingStatusText = (status: OrderStatus): string => {
  switch (status) {
    case 'pendiente_pago':
      return 'Esperando el pago';
    case 'pagado':
      return 'Pago recibido, preparando el envío';
    case 'expirado':
    case 'cancelado':
      return 'Pago no completado';
    case 'incidencia':
      return 'Reembolso en curso';
    case 'reembolsado':
      return 'Reembolso realizado';
    case 'error_borrador':
      return 'Pago recibido, preparando el envío';
    case 'borrador_creado':
      return 'Preparando el envío';
    case 'etiqueta_lista':
      return 'Preparando el envío: etiqueta lista';
    case 'en_transito':
      return 'En camino';
    case 'entregado':
    case 'liquidado':
      return 'Entregado';
  }
};

/** Proyeccion minima: nunca incluye nombre, email, telefono ni direccion de la compradora. */
export const toTrackingView = (order: Order): TrackingView => ({
  status: order.status,
  statusText: trackingStatusText(order.status),
  title: order.snapshot.title,
  artisticName: order.snapshot.artisticName,
  workPriceCents: order.workPriceCents,
  shippingCents: order.shippingCents,
  totalCents: order.totalCents,
  createdAtMs: order.createdAt,
  delivery: deliverySummary(order),
});
