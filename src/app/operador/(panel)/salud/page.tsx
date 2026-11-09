import { notFound } from 'next/navigation';
import { HEALTH_LABEL } from '@/modules/operator/domain/health';
import { QUOTAS_REVIEWED_AT, QUOTA_ITEMS } from '@/modules/operator/domain/quota-review';
import { requireOperator, requireServices } from '@/ui/server-context';

export const dynamic = 'force-dynamic';

const STATE_STYLE = {
  verde: 'border-green-700',
  ambar: 'border-amber-600',
  rojo: 'border-red-700',
} as const;

const CIRCUIT_TEXT = { closed: 'Cerrado', open: 'Abierto', half_open: 'Semiabierto' } as const;

const NoDisponible = () => <span>No disponible ahora</span>;

const stamp = (ms: number): string =>
  new Date(ms).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    dateStyle: 'short',
    timeStyle: 'short',
  });

/** EN-09: estado de salud en vivo, solo lectura; cada sección degrada por separado. */
export default async function OperadorSaludPage() {
  const actor = await requireOperator();
  const operator = requireServices().operator;
  if (!operator) notFound();
  const result = await operator.health.execute(actor);
  if (!result.ok) notFound();
  const h = result.value;

  const rows: { key: string; label: string; value: React.ReactNode }[] = [
    {
      key: 'db',
      label: 'Base de datos',
      value: h.db.ok ? h.db.value ? 'Responde' : 'No responde' : <NoDisponible />,
    },
    {
      key: 'jobs',
      label: 'Trabajos',
      value: h.jobs.ok ? (
        `${h.jobs.value.failed24h} fallidos en 24 h · ${h.jobs.value.pending} pendientes · ${h.jobs.value.running} en curso`
      ) : (
        <NoDisponible />
      ),
    },
    {
      key: 'emails',
      label: 'Correos',
      value: h.emails.ok ? (
        `${h.emails.value.pending} pendientes · ${h.emails.value.failed} fallidos`
      ) : (
        <NoDisponible />
      ),
    },
    {
      key: 'work',
      label: 'Trabajo atascado',
      value: h.work.ok ? (
        `${h.work.value.stuck} pedidos atascados · ${h.work.value.unpaidDrafts} borradores sin pagar · ${h.work.value.openFlags} incidencias abiertas · ${h.work.value.blockedSettlements} liquidaciones bloqueadas`
      ) : (
        <NoDisponible />
      ),
    },
    {
      key: 'alerts',
      label: 'Alertas en 24 h',
      value: h.alerts.ok ? (
        h.alerts.value.length === 0 ? (
          'Ninguna'
        ) : (
          h.alerts.value.map((a) => `${a.code}: ${a.n}`).join(' · ')
        )
      ) : (
        <NoDisponible />
      ),
    },
    {
      key: 'audit',
      label: 'Filas de auditoría (estimadas)',
      value: h.audit.ok ? h.audit.value.toLocaleString('es-ES') : <NoDisponible />,
    },
    {
      key: 'circuits',
      label: 'Proveedores (circuito de esta instancia)',
      value: h.circuits.ok ? (
        h.circuits.value.map((c) => `${c.provider}: ${CIRCUIT_TEXT[c.state]}`).join(' · ')
      ) : (
        <NoDisponible />
      ),
    },
    {
      key: 'backup',
      label: 'Última copia',
      value: h.backup.ok ? (
        h.backup.value ? (
          `${stamp(h.backup.value.at)} (hace ${h.backup.value.ageHours} h)`
        ) : (
          'Sin dato'
        )
      ) : (
        <NoDisponible />
      ),
    },
  ];

  return (
    <>
      <h1 data-testid="op-salud-title" className="text-2xl font-semibold">
        Salud del sistema
      </h1>
      <p
        role="status"
        data-testid="op-salud-estado"
        className={`rounded-md border-2 p-4 text-lg font-semibold ${STATE_STYLE[h.state]}`}
      >
        {HEALTH_LABEL[h.state]}
      </p>
      {h.reasons.length > 0 ? (
        <ul data-testid="op-salud-motivos" className="list-disc pl-5">
          {h.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.key} data-testid={`op-salud-${r.key}`} className="rounded-md border p-3">
            <dt className="text-sm text-[color:var(--color-texto-suave)]">{r.label}</dt>
            <dd className="font-medium">{r.value}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="cuotas" className="flex flex-col gap-2">
        <h2 id="cuotas" className="text-xl font-semibold">
          Cuotas a vigilar (umbral del 80 %)
        </h2>
        <p data-testid="op-salud-cuotas">
          Última revisión: {QUOTAS_REVIEWED_AT}
          {h.quotas.status === 'vencida' ? ' · ⚠ revisión vencida (más de 35 días)' : ''}. La
          aplicación no puede medir estos consumos: revisa los paneles de cada proveedor.
        </p>
        <ul className="list-disc pl-5">
          {QUOTA_ITEMS.map((q) => (
            <li key={q.service}>
              <strong>{q.service}:</strong> {q.watch}
            </li>
          ))}
        </ul>
      </section>
      <p className="text-sm text-[color:var(--color-texto-suave)]">
        Umbrales del estado: ámbar si hay trabajos o correos fallidos, copia de más de 36 h,
        circuito abierto o cuotas sin revisar; crítico si falla la base o la copia supera las 72 h.
      </p>
    </>
  );
}
