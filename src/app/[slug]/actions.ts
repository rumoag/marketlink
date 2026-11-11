'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Money } from '@/modules/kernel/domain/money';
import { RESUME_COOKIE_NAME, RESUME_TTL_MS } from '@/modules/checkout/domain/consent';
import type { DeliveryOptions, ShippingService } from '@/modules/checkout/domain/quote';
import { toFormState, type FormState } from '@/ui/form-state';
import { requestInfo, requireServices } from '@/ui/server-context';

/** Campos de la compradora que se repueblan tras un error (no incluye la aceptacion). */
const BUYER_FIELDS = [
  'name',
  'email',
  'phone',
  'street',
  'complement',
  'postalCode',
  'city',
  'province',
] as const;

/** Una opcion de entrega tal como la ve la compradora (US-056). */
export type OptionView = {
  readonly id: string;
  readonly name: string;
  readonly carrier: string;
  readonly transitDays: number;
  readonly priceCents: number;
  readonly modality: 'punto' | 'recogida';
  readonly destination: 'domicilio' | 'punto';
};

/** Opciones agrupadas por destino, con las destacadas y la preseleccionada (BR8-S). */
export type OptionsView = {
  readonly workCents: number;
  readonly groups: {
    readonly domicilio: readonly OptionView[];
    readonly punto: readonly OptionView[];
  };
  /** Identificadores de las destacadas (hasta 3 por grupo), en orden de precio. */
  readonly highlights: {
    readonly domicilio: readonly string[];
    readonly punto: readonly string[];
  };
  readonly preselectedId: string;
};

export type PointView = {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly schedule: string;
};

export type PointsState =
  | { readonly kind: 'lista'; readonly points: readonly PointView[] }
  | { readonly kind: 'vacia' }
  | { readonly kind: 'error' };

export type CompraState = FormState & {
  readonly options?: OptionsView;
  /** Instante de la respuesta: decide cual de las acciones es la mas reciente. */
  readonly at?: number;
  /** El total cambio al pagar: nuevo total y aviso (BR8-V5). */
  readonly changed?: boolean;
  readonly newTotalCents?: number;
  /** Hay que recalcular las opciones o la lista de puntos (BR8-V2, V3). */
  readonly refresh?: 'opciones' | 'puntos';
};

const str = (formData: FormData, name: string): string => String(formData.get(name) ?? '');

const buyerValues = (formData: FormData): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of BUYER_FIELDS) out[name] = str(formData, name);
  out.acceptTerms = formData.get('acceptTerms') === 'on' ? 'on' : '';
  out.serviceId = str(formData, 'serviceId');
  out.pointId = str(formData, 'pointId');
  return out;
};

const toOptionView = (s: ShippingService): OptionView => ({
  id: s.id,
  name: s.name,
  carrier: s.carrier,
  transitDays: s.transitDays,
  priceCents: s.priceCents,
  modality: s.modality,
  destination: s.destination,
});

const toOptionsView = (
  options: DeliveryOptions,
  workCents: number,
  preselected: ShippingService,
): OptionsView => ({
  workCents,
  groups: {
    domicilio: options.groups.domicilio.map(toOptionView),
    punto: options.groups.punto.map(toOptionView),
  },
  highlights: {
    domicilio: options.highlights.domicilio.map((s) => s.id),
    punto: options.highlights.punto.map((s) => s.id),
  },
  preselectedId: preselected.id,
});

const NO_SHIPPING_DOWN = 'No podemos calcular el envío ahora, inténtalo más tarde.';
const NO_SHIPPING_HERE = 'No hay envío posible a tu código postal.';

/** US-056 a US-063: calcula las opciones de entrega para el codigo postal indicado. */
export async function quoteOptionsAction(
  slug: string,
  _prev: CompraState,
  formData: FormData,
): Promise<CompraState> {
  const { correlationId, ip } = await requestInfo();
  const values = buyerValues(formData);
  const result = await requireServices().quoteOptions.execute(
    slug,
    str(formData, 'postalCode'),
    ip,
    correlationId,
  );
  const at = Date.now();
  if (!result.ok) {
    if (result.error.code === 'dependency_unavailable') {
      return { message: NO_SHIPPING_DOWN, values, at };
    }
    return { ...toFormState(result.error, values), values, at };
  }
  const r = result.value;
  if (r.kind === 'obra_no_disponible') {
    return { message: 'Esta obra ya no está disponible.', values, at };
  }
  if (r.kind === 'sin_envio' || r.options.preselected === undefined) {
    return { message: NO_SHIPPING_HERE, values, at };
  }
  return {
    values,
    at,
    options: toOptionsView(r.options, r.listing.priceCents, r.options.preselected),
  };
}

/** US-060: puntos de recogida de un servicio para el codigo postal de la compradora. */
export async function listPointsAction(
  slug: string,
  postalCode: string,
  serviceId: string,
): Promise<PointsState> {
  const { correlationId, ip } = await requestInfo();
  const result = await requireServices().listPoints.execute(
    slug,
    postalCode,
    serviceId,
    ip,
    correlationId,
  );
  if (!result.ok) return { kind: 'error' };
  if (result.value.length === 0) return { kind: 'vacia' };
  return {
    kind: 'lista',
    points: result.value.map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      schedule: p.schedule,
    })),
  };
}

/** US-020, US-061: inicia el pago. Nunca fia del importe ni de la eleccion que llegan del navegador. */
export async function startCheckoutAction(
  slug: string,
  submissionKey: string,
  _prev: CompraState,
  formData: FormData,
): Promise<CompraState> {
  const { correlationId, ip } = await requestInfo();
  const services = requireServices();
  const values = buyerValues(formData);
  const at = Date.now();
  const fields: Record<string, string> = {};
  for (const name of BUYER_FIELDS) fields[name] = str(formData, name);
  const expected = Number(str(formData, 'expectedTotalCents'));
  const pointId = str(formData, 'pointId');

  const result = await services.startCheckout.execute({
    slug,
    fields,
    acceptTerms: formData.get('acceptTerms') === 'on',
    serviceId: str(formData, 'serviceId'),
    pointId: pointId === '' ? undefined : pointId,
    expectedTotalCents: Number.isSafeInteger(expected) && expected > 0 ? expected : undefined,
    submissionKey,
    method: str(formData, 'method') === 'manual' ? 'manual' : 'stripe',
    ip,
    correlationId,
  });
  if (!result.ok) {
    const state = toFormState(result.error, values);
    if (
      result.error.code === 'validation' &&
      result.error.details?.some((d) => d.field === 'acceptTerms')
    ) {
      return {
        ...state,
        fieldErrors: {
          ...state.fieldErrors,
          acceptTerms: 'Para continuar debes aceptar el aviso de privacidad y las condiciones.',
        },
        at,
      };
    }
    if (
      result.error.code === 'validation' &&
      result.error.details?.some((d) => d.field === 'pointId')
    ) {
      return { message: 'Elige un punto de recogida.', values, at };
    }
    return { ...state, at };
  }

  const r = result.value;
  const setResumeCookie = async (id: string) => {
    (await cookies()).set(RESUME_COOKIE_NAME, id, {
      httpOnly: true,
      secure: services.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(RESUME_TTL_MS / 1000),
    });
  };

  switch (r.kind) {
    case 'redirect':
      await setResumeCookie(r.resumeId);
      redirect(r.url);
      break;
    case 'manual':
      await setResumeCookie(r.resumeId);
      redirect(`/seguimiento/${r.trackingToken}`);
      break;
    case 'existing_open':
      redirect(r.url);
      break;
    case 'existing_manual':
      if (r.trackingToken !== undefined) redirect(`/seguimiento/${r.trackingToken}`);
      return { message: 'Tu pedido ya está en marcha.', values, at };
    case 'existing_final':
      if (r.trackingToken !== undefined) redirect(`/seguimiento/${r.trackingToken}`);
      return { message: 'Este pedido ya se ha procesado.', values, at };
    case 'total_changed':
      return {
        values,
        at,
        changed: true,
        newTotalCents: r.totals.totalCents,
        message: `El precio del envío ha cambiado. El nuevo total es ${Money.format({ cents: r.totals.totalCents, currency: 'EUR' })}. Revísalo y confirma.`,
      };
    case 'servicio_no_disponible':
      return {
        values,
        at,
        refresh: 'opciones',
        message:
          'La opción de envío que elegiste ya no está disponible. Te mostramos las opciones actuales; elige una de nuevo.',
      };
    case 'punto_no_disponible':
      return {
        values,
        at,
        refresh: 'puntos',
        message:
          'El punto de recogida que elegiste ya no está disponible. Elige otro de la lista actual.',
      };
    case 'no_shipping':
      return { message: NO_SHIPPING_HERE, values, at, refresh: 'opciones' };
    case 'shipping_down':
      return { message: NO_SHIPPING_DOWN, values, at };
    case 'obra_no_disponible':
      return {
        message:
          r.reason === 'reservado'
            ? 'Esta obra está reservada, vuelve en unos minutos.'
            : 'Esta obra ya no está disponible.',
        values,
        at,
      };
    case 'provider_error':
      return { message: 'No hemos podido iniciar el pago, inténtalo de nuevo.', values, at };
  }
  return { message: 'Ha ocurrido un error. Prueba de nuevo más tarde.', values, at };
}
