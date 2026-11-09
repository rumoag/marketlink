import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveCorrelationId } from '@/modules/platform/infrastructure/request-pipeline';
import { clientIp } from '@/modules/platform/infrastructure/request-pipeline';
import { getServices, type Services } from '@/services/composition';

/**
 * Artista autenticado. El proxy ya comprobo la sesion y fijo esta cabecera interna (borrando
 * siempre la que enviara el cliente); si falta, la sesion no es valida.
 */
export const requireArtistId = async (): Promise<string> => {
  const id = (await headers()).get('x-ml-artist-id');
  if (!id) redirect('/acceso?caducada=1');
  return id;
};

/** Instante (ms) del ultimo acceso con enlace magico, fijado por el proxy (nunca por el cliente). */
export const loginAtMs = async (): Promise<number | undefined> => {
  const raw = (await headers()).get('x-ml-login-at');
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Operador autenticado (sesion completa con segundo factor). El proxy ya la comprobo y fijo esta
 * cabecera interna (borrando siempre la del cliente); si falta, se vuelve al acceso.
 */
export const requireOperator = async (): Promise<{ readonly email: string }> => {
  const email = (await headers()).get('x-ml-operator');
  if (!email) redirect('/operador/acceso');
  return { email };
};

export const requireServices = (): Services => {
  const services = getServices();
  if (!services) throw new Error('services_unavailable'); // lo recoge error.tsx
  return services;
};

export type RequestInfo = { readonly correlationId: string; readonly ip: string };

export const requestInfo = async (): Promise<RequestInfo> => {
  const h = await headers();
  return {
    correlationId: resolveCorrelationId(h.get('x-correlation-id')),
    ip: clientIp(h),
  };
};
