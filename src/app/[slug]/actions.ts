'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Money } from '@/modules/kernel/domain/money';
import { RESUME_COOKIE_NAME, RESUME_TTL_MS } from '@/modules/checkout/domain/consent';
import type { QuoteState } from '@/modules/checkout/application/quote-shipping';
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

/** Resumen de la cotizacion que ve la compradora (BR3-TT3, BR3-CT4). */
export type QuoteView = {
  readonly kind: 'disponible' | 'solo_alternativa' | 'sin_envio';
  readonly workCents: number;
  readonly shippingCents: number;
  readonly totalCents: number;
  readonly serviceName: string;
  readonly transitDays: number;
  readonly modality: 'punto' | 'recogida';
};

export type CompraState = FormState & {
  readonly quote?: QuoteView;
  /** Instante de la respuesta: decide cual de las dos acciones es la mas reciente. */
  readonly at?: number;
  readonly changed?: boolean;
};

const str = (formData: FormData, name: string): string => String(formData.get(name) ?? '');

const buyerValues = (formData: FormData): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of BUYER_FIELDS) out[name] = str(formData, name);
  out.acceptTerms = formData.get('acceptTerms') === 'on' ? 'on' : '';
  out.acceptedAlternative = formData.get('acceptedAlternative') === 'on' ? 'on' : '';
  return out;
};

const toQuoteView = (quote: QuoteState): QuoteView | undefined =>
  quote.kind === 'sin_envio'
    ? undefined
    : {
        kind: quote.kind,
        workCents: quote.totals.workPriceCents,
        shippingCents: quote.totals.shippingCents,
        totalCents: quote.totals.totalCents,
        serviceName: quote.service.name,
        transitDays: quote.service.transitDays,
        modality: quote.service.modality,
      };

const NO_SHIPPING = 'No podemos calcular el envío ahora, inténtalo más tarde.';

/** US-017 a US-019: calcula el envio para el codigo postal indicado. */
export async function quoteShippingAction(
  slug: string,
  _prev: CompraState,
  formData: FormData,
): Promise<CompraState> {
  const { correlationId, ip } = await requestInfo();
  const values = buyerValues(formData);
  const result = await requireServices().quote.execute(
    slug,
    str(formData, 'postalCode'),
    ip,
    correlationId,
  );
  const at = Date.now();
  if (!result.ok) return { ...toFormState(result.error, values), values, at };
  if (result.value.kind === 'obra_no_disponible') {
    return { message: 'Esta obra ya no está disponible.', values, at };
  }
  const quote = result.value.quote;
  if (quote.kind === 'sin_envio') return { message: NO_SHIPPING, values, at };
  return { values, at, quote: toQuoteView(quote) as QuoteView };
}

/** US-020: inicia el pago. Nunca fia del importe que llega del navegador (BR3-TT4). */
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

  const result = await services.startCheckout.execute({
    slug,
    fields,
    acceptTerms: formData.get('acceptTerms') === 'on',
    acceptedAlternative: formData.get('acceptedAlternative') === 'on',
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
        message: `El precio del envío ha cambiado. El nuevo total es ${Money.format({ cents: r.totals.totalCents, currency: 'EUR' })}. Revísalo y confirma.`,
        quote: toQuoteView({
          kind: 'disponible',
          service: r.service,
          totals: r.totals,
        }) as QuoteView,
      };
    case 'alternative_required':
      return {
        values,
        at,
        message:
          'Esta obra no se puede enviar de la forma elegida a tu código postal. Revisa la alternativa y acéptala para continuar.',
        quote: toQuoteView({
          kind: 'solo_alternativa',
          service: r.service,
          totals: r.totals,
        }) as QuoteView,
      };
    case 'no_shipping':
      return { message: NO_SHIPPING, values, at };
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
