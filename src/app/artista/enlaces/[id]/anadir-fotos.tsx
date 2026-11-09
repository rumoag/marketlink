'use client';

import { useActionState } from 'react';
import { FormMessage, Notice, SubmitButton } from '@/ui/controls';
import { PhotoPicker } from '@/ui/photo-picker';
import type { FormState } from '@/ui/form-state';

export function AnadirFotos({
  action,
  room,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  room: number;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <PhotoPicker max={room} label="Añadir fotos" />
      <FormMessage message={state.message} testId="fotos-error" />
      {state.success ? <Notice testId="fotos-anadidas">{state.success}</Notice> : null}
      <SubmitButton testId="fotos-anadir-button">Añadir fotos</SubmitButton>
    </form>
  );
}
