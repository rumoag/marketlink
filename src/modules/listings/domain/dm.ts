import { Money } from '@/modules/kernel/domain/money';

/**
 * Texto de «Copiar para DM» (BR2-DM1, BR2-DM2): tres lineas, sin datos personales.
 *   {titulo} — {precio}
 *   Compramela aqui con envio incluido:
 *   {baseUrl}/{slug}
 */
export const buildDmText = (
  listing: { readonly title: string; readonly priceCents: number; readonly slug: string },
  baseUrl: string,
): string => {
  const price = Money.format({ cents: listing.priceCents, currency: 'EUR' });
  const base = baseUrl.replace(/\/+$/, '');
  return `${listing.title} — ${price}\nCómpramela aquí con envío incluido:\n${base}/${listing.slug}`;
};
