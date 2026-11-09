import type { Instant } from '@/modules/kernel/domain/clock';
import { applyEntries, type LedgerEntry } from '@/modules/ledger/domain/ledger';
import type { PayoutsRepos } from './ports';

/** Un movimiento dejaria un saldo negativo o invalido: la transaccion entera se deshace (BR5-LD3). */
export class MoneyInvariantError extends Error {
  constructor(detail: string) {
    super(`money_invariant:${detail}`);
    this.name = 'MoneyInvariantError';
  }
}

/**
 * Escribe movimientos en el libro y actualiza el saldo de cada artista en la misma transaccion.
 * Idempotente: solo los movimientos nuevos (clave no vista) afectan al saldo.
 * Devuelve las claves nuevas.
 */
export const postEntries = async (
  repos: Pick<PayoutsRepos, 'ledger' | 'balances'>,
  entries: readonly LedgerEntry[],
  now: Instant,
  options: { readonly withdrawalIncrement?: { readonly artistId: string } } = {},
): Promise<readonly string[]> => {
  const inserted = await repos.ledger.insertMany(entries, now);
  const fresh = new Set(inserted);
  const byArtist = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    if (!fresh.has(e.entryKey) || e.artistId === undefined) continue;
    const list = byArtist.get(e.artistId) ?? [];
    list.push(e);
    byArtist.set(e.artistId, list);
  }
  if (options.withdrawalIncrement && !byArtist.has(options.withdrawalIncrement.artistId)) {
    byArtist.set(options.withdrawalIncrement.artistId, []);
  }
  // Orden estable por artista para que dos transacciones no se crucen en los bloqueos.
  for (const artistId of [...byArtist.keys()].sort()) {
    const list = byArtist.get(artistId) ?? [];
    const current = await repos.balances.lock(artistId);
    const next = applyEntries(current, list);
    if (!next.ok) throw new MoneyInvariantError(next.error);
    const bump = options.withdrawalIncrement?.artistId === artistId ? 1 : 0;
    await repos.balances.save(
      {
        artistId,
        retainedCents: next.value.retainedCents,
        availableCents: next.value.availableCents,
        withdrawalCount: current.withdrawalCount + bump,
      },
      now,
    );
  }
  return inserted;
};
