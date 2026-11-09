'use server';

import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { SIZE_KEYS } from '@/modules/operator/application/panel';
import type { MoneyActionError } from '@/modules/operator/application/panel';
import { PURGE_BLOCK_TEXT } from '@/modules/orders/domain/retention';
import type { FormState } from '@/ui/form-state';
import { requestInfo, requireOperator, requireServices } from '@/ui/server-context';

const ctx = async () => {
  const actor = await requireOperator();
  const operator = requireServices().operator;
  if (!operator) notFound();
  const { correlationId } = await requestInfo();
  return { actor, operator, correlationId };
};

const str = (formData: FormData, name: string): string => String(formData.get(name) ?? '');

const MONEY_MESSAGES: Record<MoneyActionError, string> = {
  forbidden: 'No tienes permiso para esta acción.',
  rate_limited: 'Demasiadas acciones seguidas. Espera un minuto.',
  code_invalid: 'El código no es correcto o ya se usó. Espera al siguiente de tu aplicación.',
  locked: 'Demasiados intentos con el código. El panel queda bloqueado 15 minutos.',
  validation: 'Revisa los datos del formulario.',
  incident_open: 'Hay una incidencia abierta: ciérrala antes de liberar el pago.',
  refund_in_progress: 'Hay un reembolso en curso para este pedido.',
  not_releasable:
    'Este pedido no se puede liberar ahora (debe tener la etiqueta lista o estar en tránsito).',
  reason_required: 'Escribe un motivo (máximo 60 caracteres).',
  already_settled: 'El pedido ya se liquidó: el reembolso requiere gestión manual con la artista.',
  exceeds_remaining: 'El importe supera lo que queda por reembolsar.',
  not_refundable: 'Este pedido no admite reembolso desde aquí.',
  manual_payment: 'Es un pago manual (Bizum directo): no se reembolsa desde el servicio.',
  no_payment: 'El pedido no tiene un pago de Stripe asociado.',
  settlement_in_progress: 'La liquidación está en curso. Prueba de nuevo en unos minutos.',
  provider_failed: 'Stripe no ha podido hacer el reembolso. Se ha avisado y puedes reintentar.',
  invalid_amount: 'Escribe un importe válido en euros, por ejemplo 12,50.',
  not_found: 'No encontramos ese pedido.',
};

const done = (orderId: string, success: string): FormState => {
  revalidatePath(`/operador/pedidos/${orderId}`);
  return { success };
};

const fail = (message: string): FormState => ({ message });

/** Borrado de datos personales a petición (BR7-PD4): motivo, código TOTP y reglas de rechazo. */
export async function erasePersonalDataAction(
  orderId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { actor, operator, correlationId } = await ctx();
  const r = await operator.erase.execute({
    actor,
    orderId,
    reason: str(formData, 'reason'),
    code: str(formData, 'code'),
    correlationId,
  });
  if (r.ok) {
    return done(
      orderId,
      r.status === 'purged'
        ? 'Datos personales eliminados. Se conservan importes y fechas.'
        : 'Los datos personales ya estaban eliminados.',
    );
  }
  if (r.error === 'blocked') return fail(PURGE_BLOCK_TEXT[r.block]);
  return fail(MONEY_MESSAGES[r.error === 'forbidden' ? 'forbidden' : r.error]);
}

export async function retryDraftAction(
  orderId: string,
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  const { actor, operator, correlationId } = await ctx();
  const r = await operator.retryDraft.execute(actor, orderId, correlationId);
  if (!r.ok) return fail('No se puede reintentar este pedido.');
  if (r.value === 'failed')
    return fail('Sigue fallando la creación del borrador. Mira el motivo en la ficha.');
  return done(orderId, 'Borrador reintentado.');
}

export async function openFlagAction(
  orderId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { actor, operator, correlationId } = await ctx();
  const r = await operator.openFlag.execute(actor, orderId, str(formData, 'reason'), correlationId);
  if (!r.ok) return fail('Escribe un motivo de hasta 120 caracteres.');
  return done(
    orderId,
    r.value === 'opened' ? 'Incidencia abierta.' : 'Ya había una incidencia abierta.',
  );
}

export async function closeFlagAction(
  orderId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { actor, operator, correlationId } = await ctx();
  const r = await operator.closeFlag.execute(
    actor,
    orderId,
    str(formData, 'resolution'),
    correlationId,
  );
  if (!r.ok)
    return fail(
      'Escribe la resolución (hasta 280 caracteres) y comprueba que hay una incidencia abierta.',
    );
  return done(orderId, 'Incidencia cerrada. La liquidación se reintentará enseguida.');
}

export async function addNoteAction(
  orderId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { actor, operator, correlationId } = await ctx();
  const r = await operator.addNote.execute(
    actor,
    orderId,
    str(formData, 'text'),
    str(formData, 'formKey'),
    correlationId,
  );
  if (!r.ok) return fail('Escribe una nota de hasta 500 caracteres.');
  return done(orderId, r.value === 'added' ? 'Nota añadida.' : 'Esa nota ya estaba guardada.');
}

export async function releaseAction(
  orderId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { actor, operator, correlationId } = await ctx();
  const r = await operator.release.execute({
    actor,
    orderId,
    reason: str(formData, 'reason'),
    code: str(formData, 'code'),
    correlationId,
  });
  if (!r.ok) return fail(MONEY_MESSAGES[r.error]);
  return done(orderId, 'Pago liberado.');
}

export async function refundAction(
  orderId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { actor, operator, correlationId } = await ctx();
  const r = await operator.refund.execute({
    actor,
    orderId,
    amount: str(formData, 'amount'),
    reason: str(formData, 'reason'),
    code: str(formData, 'code'),
    correlationId,
  });
  if (!r.ok) return fail(MONEY_MESSAGES[r.error]);
  return done(
    orderId,
    r.value.total ? 'Reembolso total realizado.' : 'Reembolso parcial realizado.',
  );
}

const num = (formData: FormData, name: string): number =>
  Number(str(formData, name).replace(',', '.'));

export async function saveSizesAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, operator, correlationId } = await ctx();
  const values = Object.fromEntries(
    SIZE_KEYS.map((k) => [
      k,
      {
        lengthCm: num(formData, `${k}_largo`),
        widthCm: num(formData, `${k}_ancho`),
        heightCm: num(formData, `${k}_alto`),
        weightKg: num(formData, `${k}_peso`),
      },
    ]),
  ) as Parameters<typeof operator.saveSizes.execute>[1];
  const r = await operator.saveSizes.execute(actor, values, correlationId);
  if (!r.ok) {
    return fail(
      'Revisa las medidas: de 5 a 150 cm (enteros), peso de 0,1 a 30 kg y largo + 2 × (ancho + alto) hasta 300 cm.',
    );
  }
  revalidatePath('/operador/tamanos');
  return {
    success:
      r.value.changed.length > 0 ? `Guardado (${r.value.changed.join(', ')}).` : 'Sin cambios.',
  };
}
