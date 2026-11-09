'use client';

import { useActionState, useState } from 'react';
import { FormMessage, SubmitButton, TextField } from '@/ui/controls';
import { emptyState, type FormState } from '@/ui/form-state';

export type OperatorField = {
  readonly name: string;
  readonly label: string;
  readonly multiline?: boolean;
  readonly maxLength?: number;
  readonly hint?: string;
  readonly inputMode?: 'text' | 'numeric' | 'decimal';
  readonly oneTimeCode?: boolean;
  readonly defaultValue?: string;
};

/**
 * Formulario de una accion del operador. Con `confirmText` la primera pulsacion solo pide
 * confirmar (dos pasos, como la retirada de la artista); la segunda envia.
 */
export function OperatorActionForm({
  action,
  testId,
  submitLabel,
  fields,
  confirmText,
  formKey,
  select,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  testId: string;
  submitLabel: string;
  fields: readonly OperatorField[];
  confirmText?: string;
  formKey?: string;
  select?: { name: string; label: string; options: readonly { value: string; label: string }[] };
}) {
  const [state, run] = useActionState(action, emptyState);
  const [confirming, setConfirming] = useState(false);
  return (
    <form action={run} className="flex flex-col gap-3" noValidate>
      {formKey ? <input type="hidden" name="formKey" value={formKey} /> : null}
      {fields.map((f) => (
        <TextField
          key={f.name}
          name={f.name}
          label={f.label}
          testId={`${testId}-${f.name}`}
          multiline={f.multiline ?? false}
          {...(f.maxLength ? { maxLength: f.maxLength } : {})}
          {...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {})}
          {...(f.hint ? { hint: f.hint } : {})}
          {...(f.inputMode ? { inputMode: f.inputMode } : {})}
          {...(f.oneTimeCode ? { autoComplete: 'one-time-code' } : {})}
        />
      ))}
      {select ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${testId}-${select.name}`} className="font-medium">
            {select.label}
          </label>
          <select
            id={`${testId}-${select.name}`}
            name={select.name}
            data-testid={`${testId}-${select.name}`}
            className="min-h-11 rounded-md border border-[color:var(--color-texto-suave)] bg-transparent px-3 py-2"
          >
            {select.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <FormMessage message={state.message} testId={`${testId}-error`} />
      {state.success ? (
        <p role="status" data-testid={`${testId}-ok`} className="rounded-md border p-3">
          {state.success}
        </p>
      ) : null}
      {confirmText && !confirming ? (
        <button
          type="button"
          data-testid={`${testId}-revisar`}
          onClick={() => setConfirming(true)}
          className="min-h-11 w-fit rounded-md border px-4 font-medium"
        >
          {submitLabel}
        </button>
      ) : (
        <div className="flex flex-col gap-3">
          {confirmText ? (
            <p data-testid={`${testId}-confirmar-texto`} className="font-medium">
              {confirmText}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <SubmitButton testId={`${testId}-submit`} pendingText="Enviando…">
              {confirmText ? 'Confirmar' : submitLabel}
            </SubmitButton>
            {confirmText ? (
              <button
                type="button"
                data-testid={`${testId}-cancelar`}
                onClick={() => setConfirming(false)}
                className="min-h-11 rounded-md border px-4 font-medium"
              >
                Cancelar
              </button>
            ) : null}
          </div>
        </div>
      )}
    </form>
  );
}
