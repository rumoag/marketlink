import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { after } from 'next/server';
import { COOKIE_ACCESS } from '@/modules/accounts/infrastructure/session-cookie';
import { clientIp } from '@/modules/platform/infrastructure/request-pipeline';
import { Money } from '@/modules/kernel/domain/money';
import { RESUME_COOKIE_NAME, newSubmissionKey } from '@/modules/checkout/domain/consent';
import { requireServices } from '@/ui/server-context';
import { legalFacts } from '@/ui/legal';
import { quoteShippingAction, startCheckoutAction } from './actions';
import { CompraForm } from './compra-form';

export const dynamic = 'force-dynamic';

// La pagina de una obra no es para buscadores: se comparte por mensaje directo.
export const metadata: Metadata = { robots: { index: false, follow: false } };

const NOTICES = {
  reservada: 'Esta obra está reservada, vuelve en unos minutos.',
  pausada: 'Esta obra no está disponible ahora.',
  vendida: 'Esta obra ya se ha vendido.',
} as const;

export default async function ObraPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const services = requireServices();

  const view = await services.listings.getPublicView(slug);
  if (!view.ok) notFound(); // slug mal formado o inexistente: misma respuesta (BR3-PP1)
  const listing = view.value;

  // U6: contador agregado de visitas, despues de responder y sin romper la pagina si falla.
  const reqHeaders = await headers();
  const hasArtistSession = (await cookies()).has(COOKIE_ACCESS);
  after(async () => {
    await services.recordVisit.execute({
      slug,
      ip: clientIp(reqHeaders),
      request: {
        userAgent: reqHeaders.get('user-agent'),
        purpose: reqHeaders.get('purpose') ?? reqHeaders.get('sec-purpose'),
        hasArtistSession,
      },
    });
  });

  // BR3-PP3: el motivo de una pausa (p. ej. cobros restringidos) nunca se revela.
  const notice = !listing.available
    ? listing.status === 'vendido'
      ? NOTICES.vendida
      : NOTICES.pausada
    : listing.reserved
      ? NOTICES.reservada
      : undefined;

  // Tras cancelar en Stripe, el formulario se rellena desde el pedido (BR3-RT3).
  const resumeId = (await cookies()).get(RESUME_COOKIE_NAME)?.value;
  const resume =
    notice === undefined
      ? await services.cancelCheckout.consumeForm(resumeId, slug.toLowerCase())
      : undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-4 py-6">
      {listing.photos.length > 0 ? (
        <div className="flex flex-col gap-3" data-testid="obra-fotos">
          {listing.photos.map((p, i) =>
            p.fullUrl ? (
              <Image
                key={p.id}
                src={p.fullUrl}
                alt={`${listing.title}, foto ${i + 1}`}
                width={800}
                height={800}
                unoptimized
                priority={i === 0}
                className="h-auto w-full rounded-md"
              />
            ) : null,
          )}
        </div>
      ) : null}

      <header className="flex flex-col gap-1">
        <h1 data-testid="obra-titulo" className="text-2xl font-semibold">
          {listing.title}
        </h1>
        {listing.artisticName ? (
          <p data-testid="obra-artista">
            de {listing.artisticName}
            {listing.instagram ? (
              <>
                {' '}
                ·{' '}
                <a
                  href={`https://instagram.com/${listing.instagram}`}
                  className="underline"
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  @{listing.instagram}
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {listing.priceCents !== undefined ? (
          <p data-testid="obra-precio" className="text-xl font-medium">
            {Money.format({ cents: listing.priceCents, currency: 'EUR' })}
          </p>
        ) : null}
      </header>

      {listing.description ? (
        <p data-testid="obra-descripcion" className="whitespace-pre-line">
          {listing.description}
        </p>
      ) : null}

      {notice ? (
        <p role="status" data-testid="obra-aviso" className="rounded-md border p-4">
          {notice}
        </p>
      ) : (
        <CompraForm
          quoteAction={quoteShippingAction.bind(null, slug)}
          payAction={startCheckoutAction.bind(null, slug, newSubmissionKey())}
          initial={resume?.fields ?? {}}
          manualEnabled={services.manualEnabled}
          listingModality={listing.modality ?? 'punto'}
        />
      )}
      <footer className="text-sm text-[color:var(--color-texto-suave)]">
        <p data-testid="obra-contacto">
          ¿Dudas o quieres ejercer tus derechos de privacidad? Escribe a {legalFacts().contactEmail}
          .
        </p>
      </footer>
    </main>
  );
}
