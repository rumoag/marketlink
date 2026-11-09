'use client';

import { useActionState, useState } from 'react';
import { FormMessage, SubmitButton } from '@/ui/controls';
import { emptyState } from '@/ui/form-state';
import { withdrawAction } from './actions';

/** Retirada en dos pasos: primero se pide confirmar el importe; la segunda pulsacion envia. */
export function RetirarForm({
  amountText,
  disabled,
  disabledReason,
}: {
  amountText: string;
  disabled: boolean;
  disabledReason: string | undefined;
}) {
  const [state, action] = useActionState(withdrawAction, emptyState);
  const [confirming, setConfirming] = useState(false);

  if (disabled) {
    return (
      <div className="flex flex-col gap-3">
        {state.success ? (
          <p role="status" data-testid="dinero-ok" className="rounded-md border p-3">
            {state.success}
          </p>
        ) : null}
        <p
          data-testid="dinero-retirar-desactivado"
          className="text-[color:var(--color-texto-suave)]"
        >
          {disabledReason}
        </p>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <FormMessage message={state.message} testId="dinero-error" />
      {state.success ? (
        <p role="status" data-testid="dinero-ok" className="rounded-md border p-3">
          {state.success}
        </p>
      ) : null}
      {confirming ? (
        <div className="flex flex-col gap-3">
          <p data-testid="dinero-confirmar-texto" className="font-medium">
            Vas a retirar {amountText} a tu cuenta bancaria. ¿Confirmas?
          </p>
          <div className="flex flex-wrap gap-3">
            <SubmitButton testId="dinero-confirmar-button" pendingText="Retirando…">
              Confirmar retirada
            </SubmitButton>
            <button
              type="button"
              data-testid="dinero-cancelar-button"
              onClick={() => setConfirming(false)}
              className="min-h-11 rounded-md border px-4 font-medium"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="dinero-retirar-button"
          onClick={() => setConfirming(true)}
          className="min-h-11 rounded-md bg-[color:var(--color-acento)] px-4 font-medium text-white"
        >
          Retirar {amountText}
        </button>
      )}
    </form>
  );
}
