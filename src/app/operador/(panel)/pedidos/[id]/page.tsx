import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/modules/kernel/domain/money';
import { REFUND_REASONS } from '@/modules/payouts/domain/payouts';
import { STUCK_TEXT, packlinkShipmentsUrl } from '@/modules/operator/domain/stuck';
import { requestInfo, requireOperator, requireServices } from '@/ui/server-context';
import {
  addNoteAction,
  erasePersonalDataAction,
  closeFlagAction,
  openFlagAction,
  refundAction,
  releaseAction,
  retryDraftAction,
} from '../../actions';
import { OperatorActionForm } from '../../operator-form';
import { deliveryText } from '@/ui/delivery-text';

export const dynamic = 'force-dynamic';

const euros = (cents: number): string => Money.format({ cents, currency: 'EUR' });
const stamp = (ms: number): string =>
  new Date(ms).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    dateStyle: 'short',
    timeStyle: 'short',
  });

const REASON_LABELS: Record<(typeof REFUND_REASONS)[number], string> = {
  obra_no_disponible: 'Obra no disponible',
  fallo_envio: 'Fallo del envío',
  error_precio: 'Error de precio',
  peticion_compradora: 'Petición de la compradora',
  otro: 'Otro',
};

const Unavailable = ({ name }: { name: string }) => (
  <p role="status" data-testid={`op-no-disponible-${name}`}>
    No disponible ahora.
  </p>
);

export default async function OperadorFichaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireOperator();
  const operator = requireServices().operator;
  if (!operator) notFound();
  const { correlationId } = await requestInfo();
  const result = await operator.orderDetail.execute(actor, id, correlationId);
  if (!result.ok) notFound();
  const d = result.value;
  const o = d.order;
  const openFlag = d.flags.ok ? d.flags.value.find((f) => f.closedAt === undefined) : undefined;
  const refunded = d.money.ok
    ? d.money.value.refunds
        .filter((r) => r.status === 'hecho')
        .reduce((s, r) => s + r.amountCents, 0)
    : 0;

  return (
    <>
      <p>
        <Link href="/operador/pedidos" className="underline">
          ← Pedidos
        </Link>
      </p>
      <h1 data-testid="op-ficha-title" className="text-2xl font-semibold">
        {o.snapshot.title}
      </h1>
      <p data-testid="op-ficha-estado">
        Estado: <strong>{o.status}</strong> · Artista: {d.artistName.ok ? d.artistName.value : '—'}{' '}
        · Total: {euros(o.totalCents)} (obra {euros(o.workPriceCents)} + envío{' '}
        {euros(o.shippingCents)})
      </p>
      {d.stuck ? (
        <p
          role="alert"
          data-testid="op-ficha-atasco"
          className="rounded-md border border-red-700 p-3"
        >
          {STUCK_TEXT[d.stuck]}
        </p>
      ) : null}

      <section aria-labelledby="envio" className="flex flex-col gap-2">
        <h2 id="envio" className="text-xl font-semibold">
          Envío
        </h2>
        <p data-testid="op-ficha-servicio">{deliveryText(d.delivery)}</p>
        {d.delivery.point ? (
          <p data-testid="op-ficha-punto">
            Punto: {d.delivery.point.name}, {d.delivery.point.address}
          </p>
        ) : null}
        {!d.shipment.ok ? (
          <Unavailable name="envio" />
        ) : d.shipment.value ? (
          <>
            <p data-testid="op-ficha-envio">
              {d.shipment.value.status}
              {d.shipment.value.carrier ? ` · ${d.shipment.value.carrier}` : ''}
              {d.shipment.value.labelCostCents !== undefined
                ? ` · etiqueta ${euros(d.shipment.value.labelCostCents)}`
                : ''}
              {d.shipment.value.incident ? ` · incidencia: ${d.shipment.value.incident}` : ''}
              {d.shipment.value.failureReason ? ` · fallo: ${d.shipment.value.failureReason}` : ''}
            </p>
            {d.shipment.value.providerRef ? (
              <p>
                <a
                  href={packlinkShipmentsUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Abrir Packlink PRO
                </a>{' '}
                · Referencia: <code data-testid="op-ficha-ref">{d.shipment.value.providerRef}</code>
              </p>
            ) : null}
          </>
        ) : (
          <p>Aún no hay envío.</p>
        )}
        {o.status === 'error_borrador' ? (
          <OperatorActionForm
            action={retryDraftAction.bind(null, o.id)}
            testId="op-reintentar"
            submitLabel="Reintentar borrador"
            fields={[]}
          />
        ) : null}
      </section>

      <section aria-labelledby="destino" className="flex flex-col gap-1">
        <h2 id="destino" className="text-xl font-semibold">
          Destino y contacto
        </h2>
        {o.destination && o.buyer ? (
          <p data-testid="op-ficha-destino">
            {o.buyer.name} · {o.buyer.email} · {o.buyer.phone}
            <br />
            {o.destination.street} {o.destination.complement}, {o.destination.postalCode}{' '}
            {o.destination.city} ({o.destination.province})
          </p>
        ) : (
          <p data-testid="op-ficha-purgado">
            Los datos personales ya se eliminaron
            {o.personalPurgedAt ? ` el ${stamp(o.personalPurgedAt)}` : ''}.
          </p>
        )}
        {o.destination && o.buyer ? (
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <h3 className="font-semibold">Borrar datos personales (a petición)</h3>
            <p className="text-sm text-[color:var(--color-texto-suave)]">
              Comprueba antes la identidad de quien lo pide (el correo del pedido). Se conservan
              importes, fechas y referencias.
            </p>
            <OperatorActionForm
              action={erasePersonalDataAction.bind(null, o.id)}
              testId="op-borrar-datos"
              submitLabel="Borrar datos personales"
              confirmText="Se eliminarán nombre, correo, teléfono y dirección de este pedido. No se puede deshacer. ¿Confirmas?"
              fields={[
                { name: 'reason', label: 'Motivo (obligatorio)', maxLength: 60 },
                {
                  name: 'code',
                  label: 'Código de tu aplicación',
                  inputMode: 'numeric',
                  maxLength: 6,
                  oneTimeCode: true,
                },
              ]}
            />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="dinero" className="flex flex-col gap-2">
        <h2 id="dinero" className="text-xl font-semibold">
          Dinero
        </h2>
        {!d.money.ok ? (
          <Unavailable name="dinero" />
        ) : (
          <>
            <p data-testid="op-ficha-liquidacion">
              Liquidación:{' '}
              {d.money.value.settlement
                ? `${d.money.value.settlement.status} (${euros(d.money.value.settlement.amountCents)})${
                    d.money.value.settlement.blockReason
                      ? ` · bloqueo: ${d.money.value.settlement.blockReason}`
                      : ''
                  }`
                : 'sin liquidación'}
            </p>
            <p data-testid="op-ficha-reembolsado">Reembolsado: {euros(refunded)}</p>
            {d.money.value.marginCents !== undefined ? (
              <p>Margen del envío: {euros(d.money.value.marginCents)}</p>
            ) : null}
          </>
        )}
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <h3 className="font-semibold">Liberar el pago</h3>
            <OperatorActionForm
              action={releaseAction.bind(null, o.id)}
              testId="op-liberar"
              submitLabel="Liberar pago"
              confirmText="Vas a marcar el pedido como entregado y liquidar a la artista. ¿Confirmas?"
              fields={[
                { name: 'reason', label: 'Motivo (obligatorio)', maxLength: 60 },
                {
                  name: 'code',
                  label: 'Código de tu aplicación',
                  inputMode: 'numeric',
                  maxLength: 6,
                  oneTimeCode: true,
                },
              ]}
            />
          </div>
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <h3 className="font-semibold">Reembolsar</h3>
            <OperatorActionForm
              action={refundAction.bind(null, o.id)}
              testId="op-reembolsar"
              submitLabel="Reembolsar"
              confirmText="El reembolso sale del saldo de la plataforma y no se puede deshacer. ¿Confirmas?"
              fields={[
                {
                  name: 'amount',
                  label: `Importe en euros (máximo ${euros(Math.max(0, o.totalCents - refunded))})`,
                  inputMode: 'decimal',
                  maxLength: 10,
                },
                {
                  name: 'code',
                  label: 'Código de tu aplicación',
                  inputMode: 'numeric',
                  maxLength: 6,
                  oneTimeCode: true,
                },
              ]}
              select={{
                name: 'reason',
                label: 'Motivo',
                options: REFUND_REASONS.map((r) => ({ value: r, label: REASON_LABELS[r] })),
              }}
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="incidencia" className="flex flex-col gap-2">
        <h2 id="incidencia" className="text-xl font-semibold">
          Incidencia manual
        </h2>
        {!d.flags.ok ? (
          <Unavailable name="incidencia" />
        ) : (
          <>
            {openFlag ? (
              <p
                role="alert"
                data-testid="op-ficha-incidencia"
                className="rounded-md border border-red-700 p-3"
              >
                Abierta por {openFlag.openedBy} el {stamp(openFlag.openedAt)}: {openFlag.reason}.
                Mientras esté abierta no se libera ni se liquida el pago.
              </p>
            ) : (
              <p>No hay ninguna incidencia abierta.</p>
            )}
            {d.flags.value
              .filter((f) => f.closedAt !== undefined)
              .map((f) => (
                <p key={f.id} className="text-sm">
                  Cerrada el {stamp(f.closedAt as number)} por {f.closedBy}: {f.resolution} (motivo:{' '}
                  {f.reason})
                </p>
              ))}
          </>
        )}
        {openFlag ? (
          <OperatorActionForm
            action={closeFlagAction.bind(null, o.id)}
            testId="op-cerrar-incidencia"
            submitLabel="Cerrar incidencia"
            fields={[{ name: 'resolution', label: 'Resolución', maxLength: 280, multiline: true }]}
          />
        ) : (
          <OperatorActionForm
            action={openFlagAction.bind(null, o.id)}
            testId="op-abrir-incidencia"
            submitLabel="Abrir incidencia"
            fields={[{ name: 'reason', label: 'Motivo', maxLength: 120 }]}
          />
        )}
      </section>

      <section aria-labelledby="notas" className="flex flex-col gap-2">
        <h2 id="notas" className="text-xl font-semibold">
          Notas internas
        </h2>
        {!d.notes.ok ? (
          <Unavailable name="notas" />
        ) : d.notes.value.length === 0 ? (
          <p>Sin notas.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {d.notes.value.map((n) => (
              <li key={n.id} data-testid="op-nota" className="rounded-md border p-3">
                <span className="text-sm text-[color:var(--color-texto-suave)]">
                  {stamp(n.at)} · {n.author}
                </span>
                <br />
                {n.text}
              </li>
            ))}
          </ul>
        )}
        <OperatorActionForm
          action={addNoteAction.bind(null, o.id)}
          testId="op-nota-nueva"
          submitLabel="Añadir nota"
          formKey={randomUUID()}
          fields={[
            {
              name: 'text',
              label: 'Nota',
              maxLength: 500,
              multiline: true,
              hint: 'Solo la ves tú (ni las artistas ni las compradoras). No escribas datos personales de la compradora.',
            },
          ]}
        />
      </section>

      <section aria-labelledby="historial" className="flex flex-col gap-2">
        <h2 id="historial" className="text-xl font-semibold">
          Línea de tiempo
        </h2>
        {!d.events.ok ? (
          <Unavailable name="historial" />
        ) : (
          <ol className="flex flex-col gap-1" data-testid="op-historial">
            {d.events.value.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                {stamp(e.at)} · {e.kind} ({e.actor}) {e.fromStatus} → {e.toStatus}
                {e.reason ? ` · ${e.reason}` : ''}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
