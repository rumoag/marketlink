'use server';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { OPERATOR_COOKIE } from '@/modules/operator/domain/operator-session';
import type { FormState } from '@/ui/form-state';
import { requestInfo, requireServices } from '@/ui/server-context';

const operatorServices = () => {
  const operator = requireServices().operator;
  if (!operator) notFound(); // el panel no esta configurado
  return operator;
};

/** Pedir el enlace: siempre la misma respuesta, este o no el email en la lista (BR6-AC1). */
export async function requestOperatorLinkAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const operator = operatorServices();
  const { correlationId, ip } = await requestInfo();
  const result = await operator.requestLink.execute(
    String(formData.get('email') ?? ''),
    ip,
    correlationId,
  );
  if (!result.ok) return { message: 'Demasiados intentos. Prueba de nuevo dentro de un rato.' };
  redirect('/operador/acceso?enviado=1');
  return {};
}

/** «Entrar»: consume el enlace, descarta la sesion del proveedor y deja la sesion pendiente. */
export async function confirmOperatorLinkAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const operator = operatorServices();
  const { correlationId } = await requestInfo();
  const result = await operator.confirmLink.execute(
    String(formData.get('token_hash') ?? ''),
    correlationId,
  );
  if (!result.ok) {
    return {
      message:
        result.error.code === 'dependency_unavailable'
          ? 'El servicio no está disponible ahora. Prueba de nuevo en unos minutos.'
          : 'Este enlace ya no es válido. Pide uno nuevo.',
    };
  }
  const cookie = operator.sessions.issueValue(result.value.email, 'pendiente_mfa');
  (await cookies()).set(OPERATOR_COOKIE, cookie.value, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: cookie.maxAge,
  });
  redirect('/operador/acceso/codigo');
  return {};
}

/** Segundo factor: el codigo convierte la sesion pendiente en completa. */
export async function verifyOperatorCodeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const operator = operatorServices();
  const { correlationId } = await requestInfo();
  const store = await cookies();
  const raw = store.get(OPERATOR_COOKIE)?.value;
  const pending = operator.sessions.pending(raw ? `${OPERATOR_COOKIE}=${raw}` : null);
  if (!pending) redirect('/operador/acceso');

  const result = await operator.verifyTotp.execute({
    email: pending.email,
    code: String(formData.get('code') ?? ''),
    purpose: 'login',
    correlationId,
  });
  if (!result.ok) {
    return {
      message:
        result.error === 'locked'
          ? 'Demasiados intentos. El acceso queda bloqueado 15 minutos.'
          : 'El código no es correcto. Prueba con el siguiente que muestre tu aplicación.',
    };
  }
  const cookie = operator.sessions.issueValue(pending.email, 'completa');
  store.set(OPERATOR_COOKIE, cookie.value, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: cookie.maxAge,
  });
  redirect('/operador');
  return {};
}

export async function signOutOperatorAction(): Promise<void> {
  (await cookies()).delete(OPERATOR_COOKIE);
  redirect('/operador/acceso');
}
