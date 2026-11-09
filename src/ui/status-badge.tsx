import type { ListingStatus, PausedReason } from '@/modules/listings/domain/listing';

const LABELS: Record<ListingStatus, string> = {
  activo: 'Activo',
  pausado: 'Pausado',
  vendido: 'Vendido',
};

const REASONS: Record<PausedReason, string> = {
  artista: 'Lo has pausado tú',
  cobros_restringidos: 'Pausado porque tus cobros están restringidos',
};

/** El estado se comunica con texto, no solo con color (U2-NFR-US2). */
export function StatusBadge({
  status,
  reason,
}: {
  status: ListingStatus;
  reason?: PausedReason | undefined;
}) {
  return (
    <span data-testid="enlace-estado-badge" className="inline-flex flex-wrap items-center gap-2">
      <span className="rounded-full border px-3 py-1 text-sm font-medium">{LABELS[status]}</span>
      {status === 'pausado' && reason ? (
        <span className="text-sm text-[color:var(--color-texto-suave)]">{REASONS[reason]}</span>
      ) : null}
    </span>
  );
}
