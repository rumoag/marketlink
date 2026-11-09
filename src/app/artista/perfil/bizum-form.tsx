'use client';

import { useActionState } from 'react';
import { FormMessage, Notice, SubmitButton, TextField } from '@/ui/controls';
import { emptyState } from '@/ui/form-state';
import { saveBizumPhoneAction } from '../actions';

/** Q5a A: telefono opcional que solo se muestra a compradoras si se activa el cobro manual. */
export function BizumForm({ bizumPhone }: { bizumPhone: string }) {
  const [state, action] = useActionState(saveBizumPhoneAction, emptyState);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate aria-label="Teléfono de Bizum">
      <h2 className="text-xl font-semibold">Teléfono de Bizum (opcional)</h2>
      <TextField
        name="bizumPhone"
        label="Teléfono de Bizum"
        testId="perfil-bizum-input"
        type="tel"
        inputMode="tel"
        hint="Solo se muestra a quien te compre si activas el cobro manual. Déjalo vacío si no lo usas."
        maxLength={32}
        defaultValue={state.values?.bizumPhone ?? bizumPhone}
        error={state.fieldErrors?.bizumPhone}
      />
      <FormMessage message={state.message} testId="perfil-bizum-error" />
      {state.success ? <Notice testId="perfil-bizum-guardado">{state.success}</Notice> : null}
      <SubmitButton testId="perfil-bizum-guardar-button">Guardar teléfono de Bizum</SubmitButton>
    </form>
  );
}
