'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { SubmitButton } from '@/ui/controls';
import { emptyState } from '@/ui/form-state';
import { confirmSignInAction } from '../actions';

/** Pagina intermedia: el enlace no se consume al abrirla, solo al pulsar «Entrar» (BR2-AC4). */
export function ConfirmarForm({
  tokenHash,
  productName,
}: {
  tokenHash: string;
  productName: string;
}) {
  const [state, action] = useActionState(confirmSignInAction, emptyState);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token_hash" value={tokenHash} />
      {state.message ? (
        <div
          role="alert"
          data-testid="confirmar-error"
          className="flex flex-col gap-3 rounded-md border border-red-700 p-3"
        >
          <p>{state.message}</p>
          <Link
            href="/acceso"
            data-testid="confirmar-pedir-otro-link"
            className="font-medium text-[color:var(--color-acento)] underline"
          >
            Pedir otro enlace
          </Link>
        </div>
      ) : null}
      <SubmitButton testId="confirmar-entrar-button" pendingText="Entrando…">
        {`Entrar en ${productName}`}
      </SubmitButton>
    </form>
  );
}
