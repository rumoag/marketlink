'use client';

import { useActionState } from 'react';
import { FormMessage, Notice, SubmitButton, TextField } from '@/ui/controls';
import type { FormState } from '@/ui/form-state';
import { PhotoPicker } from '@/ui/photo-picker';
import type { SizePreset } from '@/modules/listings/application/ports';

export type EnlaceFormValues = {
  title: string;
  description: string;
  price: string;
  declaredValue: string;
  fragile: boolean;
  size: 'S' | 'M' | 'L' | '';
  modality: 'punto' | 'recogida' | '';
};

type Props = {
  mode: 'crear' | 'editar';
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  sizes: readonly SizePreset[];
  initial: EnlaceFormValues;
  /** Hay un pago en curso: precio, valor declarado, tamano y modalidad no se pueden cambiar. */
  locked?: boolean;
};

const MODALITIES = [
  { value: 'punto', label: 'La llevo yo a un punto (más barato)' },
  { value: 'recogida', label: 'Que la recojan en casa' },
] as const;

export function EnlaceForm({ mode, action, sizes, initial, locked = false }: Props) {
  const [state, formAction] = useActionState(action, {});
  const v = state.values;
  const e = state.fieldErrors;
  const get = (key: keyof EnlaceFormValues): string => {
    const own = v?.[key];
    return own ?? String(initial[key]);
  };
  const size = get('size');
  const modality = get('modality');

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <TextField
        name="title"
        label="Título de la obra"
        testId="enlace-titulo-input"
        required
        maxLength={80}
        defaultValue={get('title')}
        error={e?.title}
      />
      <TextField
        name="description"
        label="Descripción (opcional)"
        testId="enlace-descripcion-input"
        multiline
        rows={4}
        maxLength={1000}
        hint="Técnica, medidas, lo que quieras contar. Solo texto."
        defaultValue={get('description')}
        error={e?.description}
      />
      <TextField
        name="price"
        label="Precio (€)"
        testId="enlace-precio-input"
        inputMode="decimal"
        required
        maxLength={12}
        hint="Entre 1 y 1.000 euros, por ejemplo 25 o 25,50."
        disabled={locked}
        defaultValue={get('price')}
        error={e?.price}
      />

      <fieldset className="flex flex-col gap-2" disabled={locked}>
        <legend className="font-medium">Tamaño del paquete</legend>
        {sizes.map((s) => (
          <label key={s.size} className="flex min-h-11 items-start gap-3 rounded-md border p-3">
            <input
              type="radio"
              name="size"
              value={s.size}
              defaultChecked={size === s.size}
              required
              data-testid={`enlace-tamano-radio-${s.size.toLowerCase()}`}
              className="mt-1 h-5 w-5"
            />
            <span>
              <span className="font-medium">{s.size}</span>: {s.lengthCm}×{s.widthCm}×{s.heightCm}{' '}
              cm, hasta {String(s.weightKg).replace('.', ',')} kg
              <span className="block text-sm text-[color:var(--color-texto-suave)]">
                {s.exampleLabel}
              </span>
            </span>
          </label>
        ))}
        {e?.size ? (
          <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">
            {e.size}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-2" disabled={locked}>
        <legend className="font-medium">¿Cómo la envías?</legend>
        {MODALITIES.map((m) => (
          <label key={m.value} className="flex min-h-11 items-center gap-3 rounded-md border p-3">
            <input
              type="radio"
              name="modality"
              value={m.value}
              defaultChecked={modality === m.value}
              required
              data-testid={`enlace-modalidad-radio-${m.value}`}
              className="h-5 w-5"
            />
            <span>{m.label}</span>
          </label>
        ))}
        {e?.modality ? (
          <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">
            {e.modality}
          </p>
        ) : null}
      </fieldset>

      <TextField
        name="declaredValue"
        label="Valor declarado (€)"
        testId="enlace-valor-input"
        inputMode="decimal"
        maxLength={12}
        hint="Para el seguro del envío. Si lo dejas vacío es igual al precio."
        disabled={locked}
        defaultValue={get('declaredValue')}
        error={e?.declaredValue}
      />

      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          name="fragile"
          defaultChecked={v ? v.fragile === 'true' : initial.fragile}
          data-testid="enlace-fragil-checkbox"
          className="h-5 w-5"
        />
        <span>Obra frágil</span>
      </label>

      {locked ? (
        <Notice testId="enlace-bloqueado">
          Hay un pago en curso: podrás cambiar el precio, el tamaño y el envío en unos minutos.
        </Notice>
      ) : null}

      {mode === 'crear' ? (
        <>
          <PhotoPicker max={3} />
          {e?.photos ? (
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">
              {e.photos}
            </p>
          ) : null}
        </>
      ) : null}

      <FormMessage message={state.message} testId="enlace-error" />
      {state.success ? <Notice testId="enlace-guardado">{state.success}</Notice> : null}
      <SubmitButton testId="enlace-guardar-button" pendingText="Guardando…">
        {mode === 'crear' ? 'Crear enlace' : 'Guardar cambios'}
      </SubmitButton>
    </form>
  );
}
