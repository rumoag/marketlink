'use client';

import { useActionState } from 'react';
import { FormMessage, SubmitButton } from '@/ui/controls';
import { emptyState } from '@/ui/form-state';
import { startPayoutOnboardingAction } from '../actions';

export function CobrosForm({ label, disabled }: { label: string; disabled: boolean }) {
  const [state, action] = useActionState(startPayoutOnboardingAction, emptyState);
  return (
    <form action={action} className="flex flex-col gap-3">
      <FormMessage message={state.message} testId="cobros-error" />
      {disabled ? null : (
        <SubmitButton testId="cobros-activar-button" pendingText="Abriendo Stripe…">
          {label}
        </SubmitButton>
      )}
    </form>
  );
}
