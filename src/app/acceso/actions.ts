'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { systemClock } from '@/modules/kernel/domain/clock';
import {
  buildSessionCookieSpecs,
  COOKIE_ACCESS,
  SESSION_COOKIE_NAMES,
} from '@/modules/accounts/infrastructure/session-cookie';
import { emptyState, textValues, toFormState, type FormState } from '@/ui/form-state';
import { requestInfo, requireServices } from '@/ui/server-context';

/** US-001: pedir el enlace. Siempre responde igual exista o no la cuenta (BR2-AC2). */
export async function requestLinkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const services = requireServices();
  const { correlationId, ip } = await requestInfo();
  const email = String(formData.get('email') ?? '');

  const result = await services.signIn.requestMagicLink(email, ip, correlationId);
  if (!result.ok) return toFormState(result.error, textValues(formData, ['email']));
  redirect('/acceso/enviado');
  return emptyState; // inalcanzable: redirect lanza
}

/** US-001: «Entrar». Solo aqui se consume el enlace (BR2-AC4). */
export async function confirmSignInAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const services = requireServices();
  const { correlationId } = await requestInfo();
  const tokenHash = String(formData.get('token_hash') ?? '');

  const result = await services.signIn.completeSignIn(tokenHash, correlationId);
  if (!result.ok) {
    // Mensaje generico: no se distingue entre usado, caducado o invalido (BR2-AC5).
    return {
      message:
        result.error.code === 'dependency_unavailable'
          ? 'El servicio no está disponible ahora. Prueba de nuevo en unos minutos.'
          : 'Este enlace ya no es válido. Pide uno nuevo.',
    };
  }

  const store = await cookies();
  for (const spec of buildSessionCookieSpecs(
    result.value.session,
    systemClock.now(),
    services.runtime.config.sessionCookieSecret.reveal(),
    services.secureCookies,
  )) {
    store.set(spec.name, spec.value, {
      httpOnly: true,
      secure: spec.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: spec.maxAge,
    });
  }
  redirect('/artista');
  return emptyState;
}

/** Cerrar sesion: revoca en el proveedor y borra las cookies (BR2-AC8). */
export async function signOutAction(): Promise<void> {
  const services = requireServices();
  const store = await cookies();
  const accessToken = store.get(COOKIE_ACCESS)?.value;
  if (accessToken) await services.signIn.signOut(accessToken);
  for (const name of SESSION_COOKIE_NAMES) store.delete(name);
  redirect('/acceso');
}
