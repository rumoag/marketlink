'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

const inputClass =
  'block w-full min-h-11 rounded-md border border-[color:var(--color-texto-suave)] bg-transparent px-3 py-2 text-base';

export type TextFieldProps = {
  name: string;
  label: string;
  testId: string;
  defaultValue?: string | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  type?: 'text' | 'email' | 'tel' | 'number';
  inputMode?: 'text' | 'numeric' | 'tel' | 'email' | 'decimal';
  autoComplete?: string;
  required?: boolean;
  maxLength?: number;
  disabled?: boolean;
  multiline?: boolean;
  rows?: number;
};

/** Campo con etiqueta visible, ayuda y error asociados por aria-describedby (U2-NFR-US2). */
export function TextField(props: TextFieldProps) {
  const id = `field-${props.name}`;
  const describedBy = [props.hint ? `${id}-hint` : null, props.error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  const common = {
    id,
    name: props.name,
    defaultValue: props.defaultValue,
    required: props.required ?? false,
    maxLength: props.maxLength,
    disabled: props.disabled ?? false,
    autoComplete: props.autoComplete,
    'aria-invalid': props.error ? true : undefined,
    'aria-describedby': describedBy || undefined,
    'data-testid': props.testId,
    className: inputClass,
  } as const;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {props.label}
      </label>
      {props.hint ? (
        <p id={`${id}-hint`} className="text-sm text-[color:var(--color-texto-suave)]">
          {props.hint}
        </p>
      ) : null}
      {props.multiline ? (
        <textarea {...common} rows={props.rows ?? 4} />
      ) : (
        <input {...common} type={props.type ?? 'text'} inputMode={props.inputMode} />
      )}
      {props.error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="text-sm font-medium text-red-700 dark:text-red-300"
        >
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** Boton de envio que se desactiva mientras la accion esta en curso. */
export function SubmitButton({
  children,
  pendingText = 'Guardando…',
  testId,
}: {
  children: ReactNode;
  pendingText?: string;
  testId: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      data-testid={testId}
      className="min-h-11 w-fit rounded-md bg-[color:var(--color-acento)] px-5 py-2 font-medium text-[color:var(--color-acento-texto)] disabled:opacity-60"
    >
      {pending ? pendingText : children}
    </button>
  );
}

/** Mensaje general del formulario, anunciado a los lectores de pantalla. */
export function FormMessage({ message, testId }: { message?: string | undefined; testId: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      data-testid={testId}
      className="rounded-md border border-red-700 p-3 text-red-800 dark:text-red-200"
    >
      {message}
    </p>
  );
}

export function Notice({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p
      role="status"
      data-testid={testId}
      className="rounded-md border border-[color:var(--color-acento)] p-3"
    >
      {children}
    </p>
  );
}
