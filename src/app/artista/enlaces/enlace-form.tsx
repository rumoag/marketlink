'use client';

import { useActionState, useEffect, useState } from 'react';
import { Money } from '@/modules/kernel/domain/money';
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
  /** Origenes aceptados, separados por comas: «punto», «recogida» o «punto,recogida». */
  origins: string;
};

type Props = {
  mode: 'crear' | 'editar';
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  sizes: readonly SizePreset[];
  initial: EnlaceFormValues;
  /** Hay un pago en curso: precio, valor declarado, tamano y origenes no se pueden cambiar. */
  locked?: boolean;
  /** «Desde X €» por origen para el tamano elegido (US-054). */
  pricesAction: (size: string) => Promise<{ punto?: number; recogida?: number }>;
};

const ORIGINS = [
  { value: 'punto', label: 'Llevarla a un punto u oficina' },
  { value: 'recogida', label: 'Que la recojan en mi casa' },
] as const;

export function EnlaceForm({ mode, action, sizes, initial, locked = false, pricesAction }: Props) {
  const [state, formAction] = useActionState(action, {});
  const v = state.values;
  const e = state.fieldErrors;
  const get = (key: keyof EnlaceFormValues): string => {
    const own = v?.[key];
    return own ?? String(initial[key]);
  };
  const [size, setSize] = useState<string>(get('size'));
  const origins = get('origins')
    .split(',')
    .filter((o) => o !== '');
  const [prices, setPrices] = useState<{ punto?: number; recogida?: number } | undefined>(
    undefined,
  );
  const [loadingPrices, setLoadingPrices] = useState(false);

  // Precio orientativo por origen; se vuelve a pedir al cambiar el tamano (BR8-O5).
  useEffect(() => {
    if (size === '') return;
    let cancelled = false;
    setLoadingPrices(true);
    void pricesAction(size)
      .then((p) => {
        if (!cancelled) setPrices(p);
      })
      .catch(() => {
        if (!cancelled) setPrices({});
      })
      .finally(() => {
        if (!cancelled) setLoadingPrices(false);
      });
    return () => {
      cancelled = true;
    };
  }, [size, pricesAction]);

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
              checked={size === s.size}
              onChange={() => setSize(s.size)}
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
        <legend className="font-medium">¿Cómo puedes enviar la obra?</legend>
        <input type="hidden" name="originsPresent" value="1" />
        {ORIGINS.map((o) => (
          <label key={o.value} className="flex min-h-11 items-center gap-3 rounded-md border p-3">
            <input
              type="checkbox"
              name="origins"
              value={o.value}
              defaultChecked={origins.includes(o.value)}
              data-testid={`enlace-origen-${o.value}-check`}
              className="h-5 w-5"
            />
            <span className="flex-1">{o.label}</span>
            <span
              data-testid={`enlace-precio-${o.value}`}
              className="text-sm text-[color:var(--color-texto-suave)]"
            >
              {prices?.[o.value] !== undefined
                ? `desde ${Money.format({ cents: prices[o.value] as number, currency: 'EUR' })}`
                : '—'}
            </span>
          </label>
        ))}
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-[color:var(--color-texto-suave)]"
        >
          {loadingPrices
            ? 'Calculando precios…'
            : 'Precio orientativo para un envío a Madrid; el real depende del destino. Marca todas las que puedas hacer: el comprador elegirá entre ellas.'}
        </p>
        {e?.origins ? (
          <p
            role="alert"
            data-testid="enlace-origen-error"
            className="text-sm font-medium text-red-700 dark:text-red-300"
          >
            {e.origins}
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
