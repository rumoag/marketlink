'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/ui/form-state';
import { loginAtMs, requestInfo, requireArtistId, requireServices } from '@/ui/server-context';

const MESSAGES: Record<string, string> = {
  automatic_mode: 'Stripe te paga automáticamente en tu banco: no hace falta que retires nada.',
  no_balance: 'No tienes saldo disponible para retirar ahora mismo.',
  in_progress: 'Ya tienes una retirada en curso. Espera a que termine.',
  account_not_active: 'Activa tus cobros para poder retirar tu saldo.',
  payout_failed:
    'No hemos podido iniciar la retirada. Tu saldo sigue disponible; prueba más tarde.',
  rate_limited: 'Demasiados intentos. Prueba de nuevo dentro de un rato.',
};

/**
 * US-048: retirada del saldo completo. Exige acceso reciente (si no, vuelve a pedir el enlace
 * magico) y el servidor decide el importe: nunca viene del formulario.
 */
export async function withdrawAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const artistId = await requireArtistId();
  const { correlationId } = await requestInfo();
  const services = requireServices();
  const result = await services.withdraw.execute({
    artistId,
    loginAt: await loginAtMs(),
    correlationId,
  });
  if (!result.ok) {
    if (result.error === 'login_not_recent') redirect('/acceso?caducada=1');
    return { message: MESSAGES[result.error] ?? 'No hemos podido completar la retirada.' };
  }
  revalidatePath('/artista/dinero');
  return {
    success:
      result.status === 'enviada'
        ? 'Retirada iniciada. Tu banco la recibirá en uno o dos días laborables.'
        : 'Retirada en curso. Te avisaremos cuando salga hacia tu banco.',
  };
}
