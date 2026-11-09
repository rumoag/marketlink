'use client';

import { useActionState } from 'react';
import { FormMessage, SubmitButton, TextField } from '@/ui/controls';
import { emptyState } from '@/ui/form-state';
import {
  confirmOperatorLinkAction,
  requestOperatorLinkAction,
  verifyOperatorCodeAction,
} from './actions';

export function OperatorEmailForm({ sent }: { sent: boolean }) {
  const [state, action] = useActionState(requestOperatorLinkAction, emptyState);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {sent ? (
        <p role="status" data-testid="operador-enviado" className="rounded-md border p-3">
          Si tu correo está autorizado, te hemos enviado un enlace para entrar.
        </p>
      ) : null}
      <TextField
        name="email"
        label="Correo del operador"
        testId="operador-email-input"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        maxLength={254}
      />
      <FormMessage message={state.message} testId="operador-acceso-error" />
      <SubmitButton testId="operador-email-submit" pendingText="Enviando…">
        Enviarme el enlace
      </SubmitButton>
    </form>
  );
}

export function OperatorConfirmForm({ tokenHash }: { tokenHash: string }) {
  const [state, action] = useActionState(confirmOperatorLinkAction, emptyState);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token_hash" value={tokenHash} />
      <FormMessage message={state.message} testId="operador-confirmar-error" />
      <SubmitButton testId="operador-confirmar-button" pendingText="Entrando…">
        Entrar
      </SubmitButton>
    </form>
  );
}

export function OperatorCodeForm() {
  const [state, action] = useActionState(verifyOperatorCodeAction, emptyState);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <TextField
        name="code"
        label="Código de tu aplicación de autenticación"
        testId="operador-codigo-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        maxLength={6}
        hint="Seis dígitos."
      />
      <FormMessage message={state.message} testId="operador-codigo-error" />
      <SubmitButton testId="operador-codigo-submit" pendingText="Comprobando…">
        Entrar al panel
      </SubmitButton>
    </form>
  );
}
