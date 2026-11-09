'use client';

import { useState } from 'react';

/** Enlace de seguimiento con boton para copiarlo (el email llega en U4, Q6 A). */
export function CopiarEnlace({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const absolute = typeof window === 'undefined' ? path : `${window.location.origin}${path}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="flex flex-col gap-2" aria-label="Seguimiento del pedido">
      <p>Guarda este enlace: es tu forma de consultar el pedido.</p>
      <a href={path} data-testid="exito-seguimiento-link" className="break-all underline">
        {absolute}
      </a>
      <button
        type="button"
        onClick={() => void copy()}
        data-testid="exito-copiar-button"
        className="min-h-11 w-fit rounded-md border border-[color:var(--color-acento)] px-5 py-2 font-medium"
      >
        {copied ? 'Enlace copiado' : 'Copiar enlace'}
      </button>
      <p role="status" className="sr-only">
        {copied ? 'Enlace copiado al portapapeles' : ''}
      </p>
    </section>
  );
}
