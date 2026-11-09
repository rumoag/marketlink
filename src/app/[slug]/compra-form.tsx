'use client';

import { useActionState } from 'react';
import { Money } from '@/modules/kernel/domain/money';
import { FormMessage, SubmitButton, TextField } from '@/ui/controls';
import type { CompraState, QuoteView } from './actions';

type Action = (prev: CompraState, formData: FormData) => Promise<CompraState>;

type Props = {
  quoteAction: Action;
  payAction: Action;
  initial: Readonly<Record<string, string>>;
  manualEnabled: boolean;
  /** Modalidad del enlace: explica la alternativa cuando no hay servicio de esa modalidad. */
  listingModality: 'punto' | 'recogida';
};

const euros = (cents: number): string => Money.format({ cents, currency: 'EUR' });

const MODALITY_TEXT: Record<'punto' | 'recogida', string> = {
  punto: 'entrega en un punto de recogida',
  recogida: 'recogida en el domicilio del artista',
};

const PROVINCES_HINT = 'Solo enviamos a la península.';

/** Resumen de importes (US-017): obra, envío y total, anunciado a lectores de pantalla. */
function Resumen({ quote }: { quote: QuoteView }) {
  return (
    <section
      aria-live="polite"
      aria-label="Resumen del pedido"
      data-testid="compra-resumen"
      className="flex flex-col gap-1 rounded-md border border-[color:var(--color-texto-suave)] p-4"
    >
      <p className="flex justify-between">
        <span>Obra</span>
        <span data-testid="resumen-obra">{euros(quote.workCents)}</span>
      </p>
      <p className="flex justify-between">
        <span>
          Envío ({quote.serviceName}, {quote.transitDays} {quote.transitDays === 1 ? 'día' : 'días'}
          )
        </span>
        <span data-testid="resumen-envio">{euros(quote.shippingCents)}</span>
      </p>
      <p className="flex justify-between border-t border-[color:var(--color-texto-suave)] pt-1 text-lg font-semibold">
        <span>Total</span>
        <span data-testid="resumen-total">{euros(quote.totalCents)}</span>
      </p>
    </section>
  );
}

export function CompraForm({
  quoteAction,
  payAction,
  initial,
  manualEnabled,
  listingModality,
}: Props) {
  const [quoteState, quoteFormAction] = useActionState(quoteAction, {});
  const [payState, payFormAction] = useActionState(payAction, {});

  // Gana la respuesta mas reciente; sus valores repueblan el formulario (React lo reinicia).
  const latest = (payState.at ?? 0) >= (quoteState.at ?? 0) ? payState : quoteState;
  const v = latest.values ?? initial;
  const errors = latest.fieldErrors ?? {};
  const quote = latest.quote;
  const accepted = v.acceptedAlternative === 'on';

  return (
    <form
      action={payFormAction}
      className="flex flex-col gap-4"
      noValidate
      data-testid="compra-form"
    >
      <input type="hidden" name="expectedTotalCents" value={quote?.totalCents ?? ''} />

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
          data-testid="compra-calcular-button"
          className="min-h-11 w-fit rounded-md border border-[color:var(--color-acento)] px-5 py-2 font-medium"
        >
          Calcular envío
        </button>
      </div>

      <FormMessage message={latest.message} testId="compra-error" />

      {quote ? <Resumen quote={quote} /> : null}

      {quote?.kind === 'solo_alternativa' ? (
        <div
          role="group"
          aria-label="Alternativa de envío"
          data-testid="compra-alternativa"
          className="flex flex-col gap-2 rounded-md border border-[color:var(--color-acento)] p-4"
        >
          <p>
            Esta obra se envía con {MODALITY_TEXT[listingModality]}, pero no hay ese servicio a tu
            código postal. Podemos enviarla con {MODALITY_TEXT[quote.modality]}.
          </p>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              name="acceptedAlternative"
              defaultChecked={accepted}
              data-testid="compra-alternativa-check"
            />
            <span>Acepto esta alternativa de envío</span>
          </label>
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

      <div className="flex flex-wrap gap-3">
        <SubmitButton testId="compra-pagar-button" pendingText="Un momento…">
          {latest.changed ? 'Confirmar y pagar' : 'Pagar'}
        </SubmitButton>
        {manualEnabled ? (
          <button
            type="submit"
            name="method"
            value="manual"
            data-testid="compra-manual-button"
            className="min-h-11 rounded-md border border-[color:var(--color-acento)] px-5 py-2 font-medium"
          >
            Pagar por Bizum al artista
          </button>
        ) : null}
      </div>
    </form>
  );
}
