'use client';

import { useState } from 'react';

type Outcome = 'pagar' | 'cancelar' | 'caducar';

const BUTTONS: ReadonlyArray<{ outcome: Outcome; testId: string; label: string }> = [
  { outcome: 'pagar', testId: 'e2e-pagar', label: 'Pagar' },
  { outcome: 'cancelar', testId: 'e2e-cancelar', label: 'Cancelar' },
  { outcome: 'caducar', testId: 'e2e-caducar', label: 'Dejar caducar' },
];

/**
 * Botones de la «pagina de Stripe» simulada (solo E2E). Liquidan la sesion en el servidor y
 * navegan a la URL de vuelta con una navegacion normal del navegador, como haria Stripe (una
 * redireccion de formulario la bloquearia correctamente `form-action 'self'`).
 */
export function AccionesPagoSimulado({ session }: { readonly session: string }) {
  const [busy, setBusy] = useState(false);

  async function settle(outcome: Outcome): Promise<void> {
    setBusy(true);
    const body = new FormData();
    body.set('outcome', outcome);
    const res = await fetch(`/e2e/pago/${encodeURIComponent(session)}/liquidar`, {
      method: 'POST',
      body,
    });
    if (!res.ok) {
      setBusy(false);
      return;
    }
    const { redirect } = (await res.json()) as { redirect: string };
    window.location.assign(redirect);
  }

  return (
    <div className="flex flex-wrap gap-3">
      {BUTTONS.map((b) => (
        <button
          key={b.outcome}
          type="button"
          disabled={busy}
          onClick={() => void settle(b.outcome)}
          data-testid={b.testId}
          className="min-h-11 rounded-md border px-5"
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
