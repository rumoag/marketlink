'use client';

import { useState } from 'react';

/** US-011: texto sugerido para el mensaje directo, con copia al portapapeles o seleccion manual. */
export function CopiarParaDM({ text }: { text: string }) {
  const [status, setStatus] = useState<'idle' | 'copiado' | 'manual'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copiado');
    } catch {
      // BR2-DM3: sin portapapeles se deja el texto seleccionado para copiarlo a mano.
      setStatus('manual');
      document.getElementById('dm-texto')?.focus();
      (document.getElementById('dm-texto') as HTMLTextAreaElement | null)?.select();
    }
  }

  return (
    <section aria-labelledby="dm-titulo" className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id="dm-titulo" className="text-lg font-semibold">
        Compártelo por mensaje directo
      </h2>
      <label htmlFor="dm-texto" className="sr-only">
        Texto para el mensaje directo
      </label>
      <textarea
        id="dm-texto"
        readOnly
        rows={4}
        value={text}
        data-testid="dm-texto-textarea"
        className="w-full rounded-md border bg-transparent p-3 text-base"
      />
      <button
        type="button"
        onClick={() => void copy()}
        data-testid="dm-copiar-button"
        className="min-h-11 w-fit rounded-md bg-[color:var(--color-acento)] px-5 font-medium text-[color:var(--color-acento-texto)]"
      >
        Copiar para DM
      </button>
      <p role="status" data-testid="dm-estado" className="text-sm">
        {status === 'copiado' ? 'Copiado. Pégalo en tu mensaje de Instagram.' : null}
        {status === 'manual'
          ? 'No hemos podido copiarlo automáticamente: está seleccionado, cópialo a mano.'
          : null}
      </p>
    </section>
  );
}
