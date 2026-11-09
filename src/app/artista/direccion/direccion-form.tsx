'use client';

import { useActionState } from 'react';
import { FormMessage, Notice, SubmitButton, TextField } from '@/ui/controls';
import { emptyState } from '@/ui/form-state';
import { saveAddressAction } from '../actions';

type Props = {
  street: string;
  number: string;
  floorDoor: string;
  postalCode: string;
  city: string;
  province: string;
  phone: string;
};

export function DireccionForm(initial: Props) {
  const [state, action] = useActionState(saveAddressAction, emptyState);
  const v = state.values;
  const e = state.fieldErrors;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <TextField
        name="street"
        label="Calle"
        testId="direccion-calle-input"
        autoComplete="address-line1"
        required
        maxLength={120}
        defaultValue={v?.street ?? initial.street}
        error={e?.street}
      />
      <TextField
        name="number"
        label="Número"
        testId="direccion-numero-input"
        required
        maxLength={10}
        defaultValue={v?.number ?? initial.number}
        error={e?.number}
      />
      <TextField
        name="floorDoor"
        label="Piso y puerta (opcional)"
        testId="direccion-piso-input"
        autoComplete="address-line2"
        maxLength={20}
        defaultValue={v?.floorDoor ?? initial.floorDoor}
        error={e?.floorDoor}
      />
      <TextField
        name="postalCode"
        label="Código postal"
        testId="direccion-cp-input"
        inputMode="numeric"
        autoComplete="postal-code"
        hint="De momento solo enviamos desde la península."
        required
        maxLength={5}
        defaultValue={v?.postalCode ?? initial.postalCode}
        error={e?.postalCode}
      />
      <TextField
        name="city"
        label="Ciudad"
        testId="direccion-ciudad-input"
        autoComplete="address-level2"
        required
        maxLength={60}
        defaultValue={v?.city ?? initial.city}
        error={e?.city}
      />
      <TextField
        name="province"
        label="Provincia"
        testId="direccion-provincia-input"
        autoComplete="address-level1"
        required
        maxLength={40}
        defaultValue={v?.province ?? initial.province}
        error={e?.province}
      />
      <TextField
        name="phone"
        label="Teléfono de contacto para el envío"
        testId="direccion-telefono-input"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        required
        maxLength={32}
        defaultValue={v?.phone ?? initial.phone}
        error={e?.phone}
      />
      <p className="text-sm text-[color:var(--color-texto-suave)]">País: España</p>
      <FormMessage message={state.message} testId="direccion-error" />
      {state.success ? <Notice testId="direccion-guardada">{state.success}</Notice> : null}
      <SubmitButton testId="direccion-guardar-button">Guardar dirección</SubmitButton>
    </form>
  );
}
