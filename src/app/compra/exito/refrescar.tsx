'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const EVERY_MS = 4_000;
const MAX_TRIES = 15; // unos 60 s (BR3-EX3)

/** Vuelve a pedir la pagina hasta que el aviso de Stripe llegue; no marca nada como pagado. */
export function Refrescar() {
  const router = useRouter();
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (tries > MAX_TRIES) {
        clearInterval(timer);
        return;
      }
      router.refresh();
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
