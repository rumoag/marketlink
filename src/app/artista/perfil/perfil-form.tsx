'use client';

import { useActionState } from 'react';
import { FormMessage, Notice, SubmitButton, TextField } from '@/ui/controls';
import { emptyState } from '@/ui/form-state';
import { saveProfileAction } from '../actions';

type Props = { artisticName: string; instagram: string; phone: string };

export function PerfilForm({ artisticName, instagram, phone }: Props) {
  const [state, action] = useActionState(saveProfileAction, emptyState);
  const v = state.values;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <TextField
        name="artisticName"
        label="Nombre artístico"
        testId="perfil-nombre-input"
        autoComplete="nickname"
        required
        maxLength={60}
        defaultValue={v?.artisticName ?? artisticName}
        error={state.fieldErrors?.artisticName}
      />
      <TextField
        name="instagram"
        label="Usuario de Instagram"
        testId="perfil-instagram-input"
        hint="Con o sin @. Tus compradores verán este perfil."
        required
        maxLength={31}
        defaultValue={v?.instagram ?? instagram}
        error={state.fieldErrors?.instagram}
      />
      <TextField
        name="phone"
        label="Teléfono"
        testId="perfil-telefono-input"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        hint="Solo lo vemos nosotros; nunca se muestra a los compradores."
        required
        maxLength={32}
        defaultValue={v?.phone ?? phone}
        error={state.fieldErrors?.phone}
      />
      <FormMessage message={state.message} testId="perfil-error" />
      {state.success ? <Notice testId="perfil-guardado">{state.success}</Notice> : null}
      <SubmitButton testId="perfil-guardar-button">Guardar perfil</SubmitButton>
    </form>
  );
}
