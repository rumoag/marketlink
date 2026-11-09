'use client';

import { useId, useRef, useState, type ChangeEvent } from 'react';
import { resizeForUpload, TOO_LARGE } from './resize-image';

type Item = {
  key: string;
  state: 'subiendo' | 'lista' | 'error';
  uploadId?: string;
  previewUrl?: string | undefined;
  message?: string;
};

const messageForStatus = (status: number): string => {
  if (status === 413) return 'La foto es demasiado grande.';
  if (status === 429) return 'Demasiadas fotos seguidas. Espera un poco.';
  if (status === 400) return 'No es una foto válida (usa JPG, PNG o WebP).';
  return 'No hemos podido subir esta foto. Inténtalo de nuevo.';
};

/**
 * Selector de fotos: reduce cada una en el navegador y la sube en su propia peticion. Expone los
 * identificadores de las subidas listas, en orden, en un campo oculto (la primera es la principal).
 */
export function PhotoPicker({
  max,
  name = 'uploadIds',
  label = 'Fotos de la obra',
}: {
  max: number;
  name?: string;
  label?: string;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);

  const active = items.filter((i) => i.state !== 'error');
  const ready = items.filter((i) => i.state === 'lista' && i.uploadId);
  const busy = items.some((i) => i.state === 'subiendo');

  const patch = (key: string, update: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...update } : i)));

  async function uploadOne(file: File, key: string) {
    try {
      const blob = await resizeForUpload(file);
      if (TOO_LARGE(blob)) {
        patch(key, { state: 'error', message: messageForStatus(413) });
        return;
      }
      const response = await fetch('/api/artista/fotos', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: blob,
      });
      if (!response.ok) {
        patch(key, { state: 'error', message: messageForStatus(response.status) });
        return;
      }
      const data = (await response.json()) as { uploadId: string; previewUrl?: string };
      patch(key, { state: 'lista', uploadId: data.uploadId, previewUrl: data.previewUrl });
    } catch {
      patch(key, { state: 'error', message: messageForStatus(0) });
    }
  }

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    const room = Math.max(0, max - active.length);
    const chosen = files.slice(0, room);
    const created = chosen.map((file) => ({ file, key: crypto.randomUUID() }));
    setItems((list) => [...list, ...created.map(({ key }): Item => ({ key, state: 'subiendo' }))]);
    for (const { file, key } of created) await uploadOne(file, key);
  }

  const remove = (key: string) => setItems((list) => list.filter((i) => i.key !== key));
  const move = (key: string, direction: -1 | 1) =>
    setItems((list) => {
      const index = list.findIndex((i) => i.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= list.length) return list;
      const copy = [...list];
      [copy[index], copy[target]] = [copy[target] as Item, copy[index] as Item];
      return copy;
    });

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={inputId} className="font-medium">
        {label}
      </label>
      <p className="text-sm text-[color:var(--color-texto-suave)]">
        Entre 1 y {max} fotos (JPG, PNG o WebP). La primera será la principal.
      </p>
      <input
        ref={input}
        id={inputId}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        onChange={(event) => void onChange(event)}
        disabled={active.length >= max}
        data-testid="fotos-input"
        className="block min-h-11 w-full text-base"
      />
      <ul className="flex flex-col gap-2" data-testid="fotos-lista">
        {items.map((item, index) => (
          <li
            key={item.key}
            className="flex items-center gap-3 rounded-md border p-2"
            data-testid={`fotos-item-${index + 1}`}
          >
            {item.previewUrl ? (
              <img
                src={item.previewUrl}
                alt={`Vista previa de la foto ${index + 1}`}
                width={64}
                height={64}
                className="h-16 w-16 rounded object-cover"
                data-testid={`fotos-preview-${index + 1}`}
              />
            ) : (
              <span className="flex h-16 w-16 items-center justify-center rounded border text-xs">
                {item.state === 'subiendo' ? '…' : '!'}
              </span>
            )}
            <span className="flex-1 text-sm" aria-live="polite">
              {item.state === 'subiendo'
                ? 'Subiendo…'
                : item.state === 'lista'
                  ? 'Lista'
                  : item.message}
            </span>
            {item.state === 'lista' && index > 0 ? (
              <button
                type="button"
                onClick={() => move(item.key, -1)}
                className="min-h-11 px-2 underline"
                aria-label={`Subir la foto ${index + 1}`}
              >
                ↑
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => remove(item.key)}
              className="min-h-11 px-2 underline"
              data-testid={`fotos-quitar-button-${index + 1}`}
              aria-label={`Quitar la foto ${index + 1}`}
            >
              Quitar
            </button>
          </li>
        ))}
      </ul>
      <input
        type="hidden"
        name={name}
        value={JSON.stringify(ready.map((i) => i.uploadId))}
        data-testid="fotos-ids"
      />
      <input type="hidden" name="photosBusy" value={busy ? '1' : ''} />
      {busy ? (
        <p role="status" className="text-sm">
          Subiendo fotos…
        </p>
      ) : null}
    </div>
  );
}
