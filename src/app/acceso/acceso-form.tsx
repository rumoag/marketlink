'use client';

import { useActionState } from 'react';
import { FormMessage, SubmitButton, TextField } from '@/ui/controls';
import { emptyState } from '@/ui/form-state';
import { requestLinkAction } from './actions';

export function AccesoForm({ expired }: { expired: boolean }) {
  const [state, action] = useActionState(requestLinkAction, emptyState);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {expired ? (
        <p role="status" data-testid="acceso-sesion-caducada" className="rounded-md border p-3">
          Tu sesión ha caducado. Escribe tu correo para volver a entrar.
        </p>
      ) : null}
      <TextField
        name="email"
        label="Tu correo electrónico"
        testId="acceso-email-input"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        maxLength={254}
        defaultValue={state.values?.email}
        error={state.fieldErrors?.email}
        hint="Te enviaremos un enlace para entrar, sin contraseña."
      />
      <FormMessage message={state.fieldErrors ? undefined : state.message} testId="acceso-error" />
      <SubmitButton testId="acceso-submit-button" pendingText="Enviando…">
        Enviarme el enlace
      </SubmitButton>
    </form>
  );
}
