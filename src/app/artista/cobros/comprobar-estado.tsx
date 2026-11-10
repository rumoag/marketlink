'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

/** Cada cuanto se vuelve a preguntar a Stripe mientras la activacion esta en curso. */
const CHECK_EVERY_MS = 5_000;
/** Pasado este numero de comprobaciones (unos 2 minutos) se deja de insistir solo. */
const MAX_AUTO_CHECKS = 24;

/**
 * Al volver del formulario de Stripe las capacidades de la cuenta tardan unos segundos en pasar a
 * «activas», y el aviso automatico (webhook) puede tardar mas o no estar configurado. Este
 * componente vuelve a pedir el estado a la pagina del servidor, que lo consulta a Stripe, sin que la
 * artista tenga que recargar. Con `auto` activo comprueba solo; el boton lo hace a mano.
 */
export function ComprobarEstado({ auto }: { auto: boolean }) {
  const router = useRouter();
  const [checking, startTransition] = useTransition();
  const [autoChecks, setAutoChecks] = useState(0);
  const gaveUp = autoChecks >= MAX_AUTO_CHECKS;

  useEffect(() => {
    if (!auto || gaveUp) return undefined;
    const timer = setTimeout(() => {
      setAutoChecks((n) => n + 1);
      startTransition(() => router.refresh());
    }, CHECK_EVERY_MS);
    return () => clearTimeout(timer);
  }, [auto, autoChecks, gaveUp, router]);

  const message = checking
    ? 'Comprobando con Stripe…'
    : auto && !gaveUp
      ? 'Esta pantalla se actualiza sola en cuanto Stripe termine.'
      : auto
        ? 'Stripe aún no ha terminado. Puede tardar unos minutos: pulsa «Comprobar de nuevo» o vuelve más tarde.'
        : '';

  return (
    <div className="flex flex-col gap-3">
      <p role="status" aria-live="polite" data-testid="cobros-comprobando" className="text-sm">
        {message}
      </p>
      <button
        type="button"
        data-testid="cobros-comprobar-button"
        disabled={checking}
        onClick={() => {
          setAutoChecks(0);
          startTransition(() => router.refresh());
        }}
        className="min-h-11 w-fit rounded-md border px-4 font-medium disabled:opacity-60"
      >
        {checking ? 'Comprobando…' : 'Comprobar de nuevo'}
      </button>
    </div>
  );
}
