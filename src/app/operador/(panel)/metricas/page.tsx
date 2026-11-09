import { notFound } from 'next/navigation';
import { Money } from '@/modules/kernel/domain/money';
import type { Metrics } from '@/modules/operator/domain/settings-and-metrics';
import { requestInfo, requireOperator, requireServices } from '@/ui/server-context';

export const dynamic = 'force-dynamic';

const DAY = 24 * 3_600_000;
const euros = (cents: number | undefined): string =>
  cents === undefined ? '—' : Money.format({ cents, currency: 'EUR' });
const pct = (v: number | undefined): string =>
  v === undefined ? '—' : `${v.toString().replace('.', ',')} %`;
const hours = (v: number | undefined): string =>
  v === undefined ? '—' : `${v.toString().replace('.', ',')} h`;
const parseDay = (v: string | undefined): number | undefined => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : t;
};

const PERIODS = [
  { key: 'hoy', label: 'Hoy', days: 1 },
  { key: '7', label: '7 días', days: 7 },
  { key: '28', label: '28 días', days: 28 },
] as const;

type Row = {
  key: string;
  label: string;
  definition: string;
  value: (m: Metrics) => string;
};

const ROWS: readonly Row[] = [
  {
    key: 'enlaces',
    label: 'Enlaces creados',
    definition: 'Obras publicadas en el periodo.',
    value: (m) => String(m.raw.listingsCreated),
  },
  {
    key: 'visitas',
    label: 'Visitas',
    definition:
      'Cargas de la página pública de una obra (sin robots ni la propia artista). No son visitantes únicos: quien recarga suma.',
    value: (m) => String(m.raw.views),
  },
  {
    key: 'pedidos',
    label: 'Pedidos pagados',
    definition: 'Pedidos cuyo pago se confirmó en el periodo.',
    value: (m) => String(m.raw.paidOrders),
  },
  {
    key: 'conversion',
    label: 'Conversión',
    definition: 'Pedidos pagados / visitas.',
    value: (m) => pct(m.conversionPct),
  },
  {
    key: 'tarjeta',
    label: 'Tarjeta',
    definition: 'Del total con método conocido (se conoce al liquidar).',
    value: (m) => pct(m.cardPct),
  },
  {
    key: 'bizum',
    label: 'Bizum',
    definition: 'Del total con método conocido (se conoce al liquidar).',
    value: (m) => pct(m.bizumPct),
  },
  {
    key: 'punto',
    label: 'Entrega en punto',
    definition: 'Pedidos con entrega en punto / (punto + recogida).',
    value: (m) => pct(m.puntoPct),
  },
  {
    key: 'recogida',
    label: 'Recogida',
    definition: 'Pedidos con recogida / (punto + recogida).',
    value: (m) => pct(m.recogidaPct),
  },
  {
    key: 'envio',
    label: 'Envío cobrado (medio)',
    definition: 'Media del envío cobrado a la compradora.',
    value: (m) => euros(m.avgShippingCents),
  },
  {
    key: 'etiqueta',
    label: 'Coste de etiqueta (medio)',
    definition: 'Media del coste real de la etiqueta (pedidos con coste conocido).',
    value: (m) => euros(m.avgLabelCostCents),
  },
  {
    key: 'tiempo',
    label: 'Tiempo pago → etiqueta',
    definition: 'Media entre el pago y la etiqueta lista.',
    value: (m) => hours(m.avgPayToLabelHours),
  },
  {
    key: 'incidencias',
    label: 'Incidencias',
    definition: 'Automáticas (envío, doble pago) y manuales abiertas en el periodo.',
    value: (m) => String(m.raw.incidents),
  },
  {
    key: 'repeticion',
    label: 'Artistas que repiten',
    definition: 'Artistas con 2 o más pedidos pagados en el periodo.',
    value: (m) => `${m.raw.repeatArtists} de ${m.raw.artistsWithOrders}`,
  },
];

export default async function OperadorMetricasPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string; desde?: string; hasta?: string }>;
}) {
  const actor = await requireOperator();
  const operator = requireServices().operator;
  if (!operator) notFound();
  const { correlationId } = await requestInfo();
  const q = await searchParams;

  const tomorrow = Math.floor(Date.now() / DAY) * DAY + DAY;
  const preset = PERIODS.find((x) => x.key === q.p);
  const fromDay = parseDay(q.desde);
  const toDay = parseDay(q.hasta);
  const custom = fromDay !== undefined && toDay !== undefined && toDay >= fromDay;
  const days = preset?.days ?? 28;
  const to = custom ? toDay + DAY : tomorrow;
  const from = custom ? fromDay : to - days * DAY;

  const result = await operator.metrics.execute(actor, from, to, correlationId);
  const section = result.ok ? result.value : ({ ok: false } as const);

  return (
    <>
      <h1 data-testid="op-metricas-title" className="text-2xl font-semibold">
        Métricas de validación
      </h1>
      <nav aria-label="Periodo" className="flex flex-wrap gap-3">
        {PERIODS.map((x) => (
          <a
            key={x.key}
            href={`/operador/metricas?p=${x.key}`}
            data-testid={`op-periodo-${x.key}`}
            className="min-h-11 rounded-md border px-3 py-2 font-medium"
          >
            {x.label}
          </a>
        ))}
      </nav>
      <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Rango de fechas">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Desde</span>
          <input
            type="date"
            name="desde"
            defaultValue={q.desde ?? ''}
            className="min-h-11 rounded-md border bg-transparent px-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Hasta</span>
          <input
            type="date"
            name="hasta"
            defaultValue={q.hasta ?? ''}
            className="min-h-11 rounded-md border bg-transparent px-2"
          />
        </label>
        <button type="submit" className="min-h-11 rounded-md border px-4 font-medium">
          Ver rango
        </button>
      </form>

      {!section.ok ? (
        <p role="alert" data-testid="op-metricas-error">
          No se pueden calcular las métricas ahora. Prueba de nuevo en unos minutos.
        </p>
      ) : (
        <>
          {section.value.current.lowData ? (
            <p role="status" data-testid="op-pocos-datos" className="rounded-md border p-3">
              Pocos datos: menos de 5 pedidos en el periodo, los porcentajes tienen poca base.
            </p>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-left" data-testid="op-metricas-tabla">
              <caption className="sr-only">Métricas del periodo y del anterior</caption>
              <thead>
                <tr>
                  <th scope="col">Cifra</th>
                  <th scope="col">Periodo</th>
                  <th scope="col">Anterior</th>
                  <th scope="col">Definición</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr
                    key={r.key}
                    className="border-t align-top"
                    data-testid={`op-metrica-${r.key}`}
                  >
                    <th scope="row">{r.label}</th>
                    <td data-testid={`op-metrica-${r.key}-actual`}>
                      {r.value(section.value.current)}
                    </td>
                    <td>{r.value(section.value.previous)}</td>
                    <td className="text-sm text-[color:var(--color-texto-suave)]">
                      {r.definition}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
