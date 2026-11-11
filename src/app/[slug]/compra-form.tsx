'use client';

import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { Money } from '@/modules/kernel/domain/money';
import { FormMessage, SubmitButton, TextField } from '@/ui/controls';
import type { CompraState, OptionView, OptionsView, PointsState } from './actions';

type Action = (prev: CompraState, formData: FormData) => Promise<CompraState>;
type PointsAction = (postalCode: string, serviceId: string) => Promise<PointsState>;

type Props = {
  quoteAction: Action;
  pointsAction: PointsAction;
  payAction: Action;
  initial: Readonly<Record<string, string>>;
  manualEnabled: boolean;
};

const euros = (cents: number): string => Money.format({ cents, currency: 'EUR' });

const PROVINCES_HINT = 'Solo enviamos a la península.';

/** Codigo postal espanol completo: al escribirlo se calcula el envio sin pulsar nada. */
const COMPLETE_POSTAL_CODE = /^\d{5}$/;
/** Espera tras la ultima tecla antes de calcular, para no consultar a cada digito. */
const AUTO_QUOTE_DELAY_MS = 600;
/** Puntos visibles al principio; «Mostrar mas» enseña el resto (BR8-PT1). */
const POINTS_PAGE = 10;

const days = (n: number): string => `${n} ${n === 1 ? 'día' : 'días'}`;

/** Resumen de importes (US-059): obra, envio y total, anunciado a lectores de pantalla. */
function Resumen({
  workCents,
  option,
  totalCents,
}: {
  workCents: number;
  option: OptionView;
  totalCents: number;
}) {
  return (
    <section
      aria-live="polite"
      aria-label="Resumen del pedido"
      data-testid="compra-resumen"
      className="flex flex-col gap-1 rounded-md border border-[color:var(--color-texto-suave)] p-4"
    >
      <p className="flex justify-between">
        <span>Obra</span>
        <span data-testid="resumen-obra">{euros(workCents)}</span>
      </p>
      <p className="flex justify-between">
        <span>
          Envío ({option.carrier} {option.name}, {days(option.transitDays)})
        </span>
        <span data-testid="resumen-envio">{euros(option.priceCents)}</span>
      </p>
      <p className="flex justify-between border-t border-[color:var(--color-texto-suave)] pt-1 text-lg font-semibold">
        <span>Total</span>
        <span data-testid="resumen-total">{euros(totalCents)}</span>
      </p>
    </section>
  );
}

/** Un grupo de opciones (A tu domicilio / En un punto de recogida): destacadas y «Ver todas». */
function GrupoOpciones({
  title,
  testId,
  allTestId,
  options,
  highlightIds,
  selectedId,
  onSelect,
}: {
  title: string;
  testId: string;
  allTestId: string;
  options: readonly OptionView[];
  highlightIds: readonly string[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (options.length === 0) return null;
  const visible = expanded
    ? options
    : options.filter((o) => highlightIds.includes(o.id) || o.id === selectedId);
  return (
    <fieldset
      role="radiogroup"
      aria-label={title}
      data-testid={testId}
      className="flex flex-col gap-2 rounded-md border border-[color:var(--color-texto-suave)] p-3"
    >
      <legend className="px-1 font-semibold">{title}</legend>
      {visible.map((o) => (
        <label
          key={o.id}
          className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md p-2 has-[:checked]:bg-[color:var(--color-texto-suave)]/10"
        >
          <input
            type="radio"
            name="serviceId"
            value={o.id}
            checked={selectedId === o.id}
            onChange={() => onSelect(o.id)}
            data-testid={`compra-opcion-${o.id}`}
            className="mt-1"
          />
          <span className="flex flex-1 flex-col">
            <span className="font-medium">
              {o.carrier} · {o.name}
            </span>
            <span className="text-sm text-[color:var(--color-texto-suave)]">
              Entrega estimada en {days(o.transitDays)}
            </span>
          </span>
          <span className="font-medium">{euros(o.priceCents)}</span>
        </label>
      ))}
      {options.length > highlightIds.length ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          data-testid={allTestId}
          className="min-h-11 w-fit text-sm underline"
        >
          {expanded ? 'Ver menos' : 'Ver todas'}
        </button>
      ) : null}
    </fieldset>
  );
}

export function CompraForm({
  quoteAction,
  pointsAction,
  payAction,
  initial,
  manualEnabled,
}: Props) {
  // `quoteState` es la ruta sin JavaScript (el boton envia el formulario con su accion). Con
  // JavaScript el calculo se hace en segundo plano (`autoState`) sin enviar el formulario, para que
  // React no lo reinicie y no se pierda lo que la persona sigue escribiendo mientras se calcula.
  const [quoteState, quoteFormAction] = useActionState(quoteAction, {});
  const [payState, payFormAction] = useActionState(payAction, {});
  const [autoState, setAutoState] = useState<CompraState>({});
  const [quoting, startQuote] = useTransition();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [pointId, setPointId] = useState<string | undefined>(undefined);
  const [points, setPoints] = useState<PointsState | 'cargando' | undefined>(undefined);
  const [showAllPoints, setShowAllPoints] = useState(false);
  const [overrideTotal, setOverrideTotal] = useState<number | undefined>(undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const lastQuoted = useRef<string>('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const runQuote = () => {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    lastQuoted.current = String(data.get('postalCode') ?? '').trim();
    startQuote(async () => {
      setAutoState(await quoteAction({}, data));
    });
  };

  const loadPoints = (serviceId: string) => {
    const postal = lastQuoted.current || String(initial.postalCode ?? '').trim();
    setPoints('cargando');
    setShowAllPoints(false);
    void pointsAction(postal, serviceId).then(setPoints, () => setPoints({ kind: 'error' }));
  };

  // Al volver de un pago cancelado el formulario llega relleno: se calcula el envio de entrada.
  useEffect(() => {
    if (COMPLETE_POSTAL_CODE.test((initial.postalCode ?? '').trim())) runQuote();
    return () => clearTimeout(timer.current);
    // Solo al montar: runQuote lee el formulario en el momento de ejecutarse.
  }, []);

  const onFormChange = (event: React.FormEvent<HTMLFormElement>) => {
    const target = event.target as HTMLInputElement;
    if (target.name !== 'postalCode') return;
    clearTimeout(timer.current);
    const value = target.value.trim();
    if (!COMPLETE_POSTAL_CODE.test(value) || value === lastQuoted.current) return;
    timer.current = setTimeout(runQuote, AUTO_QUOTE_DELAY_MS);
  };

  // Los valores del formulario vienen de la ultima accion enviada (pago o calculo sin JS); el
  // calculo en segundo plano no los toca. La respuesta mas reciente decide el resto.
  const valuesFrom = (payState.at ?? 0) >= (quoteState.at ?? 0) ? payState : quoteState;
  const latest = [payState, quoteState, autoState].reduce((a, b) =>
    (b.at ?? 0) > (a.at ?? 0) ? b : a,
  );
  const optionsState = (autoState.at ?? 0) >= (quoteState.at ?? 0) ? autoState : quoteState;
  const options: OptionsView | undefined = optionsState.options;
  const v = valuesFrom.values ?? initial;
  const errors = latest.fieldErrors ?? {};

  // Un calculo nuevo descarta lo elegido (BR8-C3): vuelve la preseleccion y se borra el punto.
  useEffect(() => {
    setSelectedId(undefined);
    setPointId(undefined);
    setPoints(undefined);
    setOverrideTotal(undefined);
  }, [optionsState.at]);

  const all: readonly OptionView[] = options
    ? [...options.groups.domicilio, ...options.groups.punto]
    : [];
  const effectiveId = selectedId ?? options?.preselectedId;
  const selected = all.find((o) => o.id === effectiveId);
  const needsPoint = selected?.destination === 'punto';

  // Carga de puntos al elegir una opcion con destino punto (BR8-PT1).
  useEffect(() => {
    if (needsPoint && selected) loadPoints(selected.id);
    else setPoints(undefined);
    // Solo cuando cambia la opcion elegida.
  }, [selected?.id, needsPoint]);

  // Respuestas del pago que piden recalcular o confirmar un nuevo total (BR8-V2, V3, V5).
  useEffect(() => {
    if (!payState.at) return;
    if (payState.refresh === 'opciones') runQuote();
    else if (payState.refresh === 'puntos' && selected) {
      setPointId(undefined);
      loadPoints(selected.id);
    } else if (payState.changed && payState.newTotalCents !== undefined) {
      setOverrideTotal(payState.newTotalCents);
    }
    // Solo cuando llega una respuesta nueva del pago.
  }, [payState.at]);

  const totalCents =
    selected && options ? (overrideTotal ?? options.workCents + selected.priceCents) : 0;
  const canPay = selected !== undefined && (!needsPoint || pointId !== undefined);
  const pointList = typeof points === 'object' && points.kind === 'lista' ? points.points : [];
  const visiblePoints = showAllPoints ? pointList : pointList.slice(0, POINTS_PAGE);

  return (
    <form
      ref={formRef}
      action={payFormAction}
      onChange={onFormChange}
      className="flex flex-col gap-4"
      noValidate
      data-testid="compra-form"
    >
      <input type="hidden" name="expectedTotalCents" value={selected ? totalCents : ''} />

      <TextField
        name="name"
        label="Nombre y apellidos"
        testId="compra-nombre-input"
        autoComplete="name"
        required
        maxLength={80}
        defaultValue={v.name}
        error={errors.name}
      />
      <TextField
        name="email"
        label="Correo electrónico"
        testId="compra-email-input"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        maxLength={254}
        defaultValue={v.email}
        error={errors.email}
      />
      <TextField
        name="phone"
        label="Teléfono"
        testId="compra-telefono-input"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        required
        maxLength={32}
        defaultValue={v.phone}
        error={errors.phone}
        hint="Lo usa el transportista para avisarte de la entrega."
      />
      <TextField
        name="street"
        label="Calle y número"
        testId="compra-calle-input"
        autoComplete="address-line1"
        required
        maxLength={120}
        defaultValue={v.street}
        error={errors.street}
      />
      <TextField
        name="complement"
        label="Piso, puerta… (opcional)"
        testId="compra-complemento-input"
        autoComplete="address-line2"
        maxLength={60}
        defaultValue={v.complement}
        error={errors.complement}
      />
      <TextField
        name="postalCode"
        label="Código postal"
        testId="compra-cp-input"
        inputMode="numeric"
        autoComplete="postal-code"
        required
        maxLength={16}
        defaultValue={v.postalCode}
        error={errors.postalCode}
        hint={PROVINCES_HINT}
      />
      <TextField
        name="city"
        label="Localidad"
        testId="compra-localidad-input"
        autoComplete="address-level2"
        required
        maxLength={80}
        defaultValue={v.city}
        error={errors.city}
      />
      <TextField
        name="province"
        label="Provincia"
        testId="compra-provincia-input"
        autoComplete="address-level1"
        required
        maxLength={40}
        defaultValue={v.province}
        error={errors.province}
      />

      <div className="flex flex-col gap-2">
        <button
          type="submit"
          formAction={quoteFormAction}
          onClick={(event) => {
            // Con JavaScript se calcula en segundo plano; sin el, el formulario se envia normal.
            event.preventDefault();
            runQuote();
          }}
          disabled={quoting}
          data-testid="compra-calcular-button"
          className="min-h-11 w-fit rounded-md border border-[color:var(--color-acento)] px-5 py-2 font-medium"
        >
          {quoting ? 'Calculando…' : 'Calcular envío'}
        </button>
        <p role="status" aria-live="polite" data-testid="compra-calculando" className="text-sm">
          {quoting ? 'Calculando el envío…' : ''}
        </p>
      </div>

      <FormMessage message={latest.message} testId="compra-error" />

      {options && !quoting ? (
        <div className="flex flex-col gap-3" data-testid="compra-opciones">
          <GrupoOpciones
            title="A tu domicilio"
            testId="compra-grupo-domicilio"
            allTestId="compra-ver-todas-domicilio"
            options={options.groups.domicilio}
            highlightIds={options.highlights.domicilio}
            selectedId={effectiveId}
            onSelect={(id) => {
              setSelectedId(id);
              setPointId(undefined);
              setOverrideTotal(undefined);
            }}
          />
          <GrupoOpciones
            title="En un punto de recogida"
            testId="compra-grupo-punto"
            allTestId="compra-ver-todas-punto"
            options={options.groups.punto}
            highlightIds={options.highlights.punto}
            selectedId={effectiveId}
            onSelect={(id) => {
              setSelectedId(id);
              setPointId(undefined);
              setOverrideTotal(undefined);
            }}
          />

          {needsPoint ? (
            <fieldset
              role="radiogroup"
              aria-label="Punto de recogida"
              id="selector-punto"
              data-testid="compra-selector-punto"
              className="flex flex-col gap-2 rounded-md border border-[color:var(--color-acento)] p-3"
            >
              <legend className="px-1 font-semibold">Elige tu punto de recogida</legend>
              <p role="status" aria-live="polite" className="text-sm">
                {points === 'cargando' ? 'Buscando puntos de recogida…' : ''}
              </p>
              {typeof points === 'object' && points.kind === 'vacia' ? (
                <p data-testid="compra-punto-error">
                  No hay puntos de recogida para este servicio en tu código postal. Elige otra
                  opción.
                </p>
              ) : null}
              {typeof points === 'object' && points.kind === 'error' ? (
                <p role="alert" data-testid="compra-punto-error">
                  No podemos cargar los puntos ahora. Prueba de nuevo en un momento.
                </p>
              ) : null}
              {visiblePoints.map((p) => (
                <label
                  key={p.id}
                  className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md p-2 has-[:checked]:bg-[color:var(--color-texto-suave)]/10"
                >
                  <input
                    type="radio"
                    name="pointId"
                    value={p.id}
                    checked={pointId === p.id}
                    onChange={() => setPointId(p.id)}
                    data-testid={`compra-punto-${p.id}`}
                    className="mt-1"
                  />
                  <span className="sr-only">Punto de recogida:</span>
                  <span className="flex flex-col">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-sm">{p.address}</span>
                    <span className="text-sm text-[color:var(--color-texto-suave)]">
                      {p.schedule}
                    </span>
                  </span>
                </label>
              ))}
              {pointList.length > visiblePoints.length ? (
                <button
                  type="button"
                  onClick={() => setShowAllPoints(true)}
                  data-testid="compra-mostrar-mas-puntos"
                  className="min-h-11 w-fit text-sm underline"
                >
                  Mostrar más
                </button>
              ) : null}
            </fieldset>
          ) : null}

          {selected ? (
            <Resumen workCents={options.workCents} option={selected} totalCents={totalCents} />
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <label className="flex min-h-11 items-start gap-2">
          <input
            type="checkbox"
            name="acceptTerms"
            defaultChecked={v.acceptTerms === 'on'}
            aria-describedby={errors.acceptTerms ? 'terms-error' : undefined}
            aria-invalid={errors.acceptTerms ? true : undefined}
            data-testid="compra-acepto-check"
            className="mt-1"
          />
          <span>
            He leído el{' '}
            <a href="/privacidad" className="underline" target="_blank" rel="noreferrer">
              aviso de privacidad
            </a>{' '}
            y acepto las{' '}
            <a href="/condiciones" className="underline" target="_blank" rel="noreferrer">
              condiciones de compra
            </a>
            .
          </span>
        </label>
        {errors.acceptTerms ? (
          <p
            id="terms-error"
            role="alert"
            className="text-sm font-medium text-red-700 dark:text-red-300"
          >
            {errors.acceptTerms}
          </p>
        ) : null}
      </div>

      {needsPoint && pointId === undefined ? (
        <p data-testid="compra-falta-punto" className="text-sm">
          <a href="#selector-punto" className="underline">
            Elige un punto de recogida
          </a>{' '}
          para poder pagar.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <SubmitButton
          testId="compra-pagar-button"
          pendingText="Un momento…"
          disabled={options !== undefined && !canPay}
        >
          {latest.changed ? 'Confirmar y pagar' : 'Pagar'}
        </SubmitButton>
        {manualEnabled ? (
          <button
            type="submit"
            name="method"
            value="manual"
            disabled={options !== undefined && !canPay}
            data-testid="compra-manual-button"
            className="min-h-11 rounded-md border border-[color:var(--color-acento)] px-5 py-2 font-medium disabled:opacity-60"
          >
            Pagar por Bizum al artista
          </button>
        ) : null}
      </div>
    </form>
  );
}
