import Link from 'next/link';
import { Money } from '@/modules/kernel/domain/money';
import { requireArtistId, requireServices } from '@/ui/server-context';
import { RetirarForm } from './retirar-form';

export const dynamic = 'force-dynamic';

const euros = (cents: number): string => Money.format({ cents, currency: 'EUR' });
const date = (ms: number): string =>
  new Date(ms).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });

const WITHDRAWAL_TEXT = {
  solicitada: 'En curso',
  enviada: 'Enviada a tu banco',
  fallida: 'No se pudo completar',
} as const;

const MOVEMENT_TEXT: Record<string, string> = {
  retencion: 'Venta retenida',
  liquidacion: 'Cobro liberado',
  retirada: 'Retirada',
  reembolso: 'Reembolso',
  ajuste: 'Ajuste',
};

/** US-047: saldos, retención explicada por pedido, retirada e historial. */
export default async function DineroPage() {
  const artistId = await requireArtistId();
  const view = await requireServices().moneyOverview.execute(artistId);
  const automatic = view.mode === 'automatico';
  const disabledReason = automatic
    ? 'Stripe te paga automáticamente en tu banco. Aquí ves tus saldos e historial.'
    : !view.accountActive
      ? 'Activa tus cobros para poder retirar tu saldo.'
      : view.hasOpenWithdrawal
        ? 'Tienes una retirada en curso.'
        : view.availableCents <= 0
          ? 'No tienes saldo disponible para retirar.'
          : undefined;

  return (
    <>
      <h1 data-testid="dinero-title" className="text-2xl font-semibold">
        Tu dinero
      </h1>

      <section aria-labelledby="saldos" className="grid gap-3 sm:grid-cols-2">
        <h2 id="saldos" className="sr-only">
          Saldos
        </h2>
        <div className="rounded-md border p-4">
          <p className="text-sm text-[color:var(--color-texto-suave)]">Disponible</p>
          <p data-testid="dinero-disponible" className="text-2xl font-semibold">
            {euros(view.availableCents)}
          </p>
        </div>
        <div className="rounded-md border p-4">
          <p className="text-sm text-[color:var(--color-texto-suave)]">En retención</p>
          <p data-testid="dinero-retenido" className="text-2xl font-semibold">
            {euros(view.retainedCents)}
          </p>
        </div>
      </section>

      {!view.accountActive ? (
        <p role="alert" data-testid="dinero-cuenta-inactiva" className="rounded-md border p-3">
          Activa tus cobros para recibir tu dinero.{' '}
          <Link href="/artista/cobros" className="font-medium underline">
            Ir a Cobros
          </Link>
        </p>
      ) : null}

      <RetirarForm
        amountText={euros(view.availableCents)}
        disabled={disabledReason !== undefined}
        disabledReason={disabledReason}
      />

      <section aria-labelledby="retenido" className="flex flex-col gap-2">
        <h2 id="retenido" className="text-lg font-semibold">
          Ventas en retención
        </h2>
        {view.retained.length === 0 ? (
          <p data-testid="dinero-retenido-vacio">No tienes ventas pendientes de liberar.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.retained.map((r) => (
              <li
                key={r.orderId}
                data-testid="dinero-retenido-item"
                className="rounded-md border p-3"
              >
                <Link href={`/artista/pedidos/${r.orderId}`} className="font-medium underline">
                  {r.title}
                </Link>
                <p>
                  {euros(r.amountCents)} ·{' '}
                  <span data-testid="dinero-retenido-motivo">{r.reason}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="retiradas" className="flex flex-col gap-2">
        <h2 id="retiradas" className="text-lg font-semibold">
          Retiradas
        </h2>
        {view.withdrawals.length === 0 ? (
          <p>Todavía no has hecho ninguna retirada.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.withdrawals.map((w) => (
              <li key={w.id} data-testid="dinero-retirada-item" className="rounded-md border p-3">
                {date(w.createdAt)} · {euros(w.amountCents)} · {WITHDRAWAL_TEXT[w.status]}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="movimientos" className="flex flex-col gap-2">
        <h2 id="movimientos" className="text-lg font-semibold">
          Movimientos
        </h2>
        {view.movements.length === 0 ? (
          <p>Aún no hay movimientos.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {view.movements
              .filter((m) => !(m.kind === 'liquidacion' && m.bucket === 'retenido'))
              .map((m) => (
                <li
                  key={m.entryKey}
                  data-testid="dinero-movimiento"
                  className="flex justify-between gap-3"
                >
                  <span>
                    {date(m.at)} · {MOVEMENT_TEXT[m.kind] ?? m.kind}
                  </span>
                  <span>{euros(Math.abs(m.deltaCents))}</span>
                </li>
              ))}
          </ul>
        )}
      </section>
    </>
  );
}
