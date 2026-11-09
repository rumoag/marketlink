import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { formatMadrid } from '@/modules/kernel/domain/dates';
import { Money } from '@/modules/kernel/domain/money';
import type { DraftInvoice, InvoiceRenderer } from '../application/ports';

export const DRAFT_MARK = 'BORRADOR – no válido como factura';

const eur = (cents: number): string => Money.format({ cents, currency: 'EUR' });

/** PDF de una pagina con la marca de borrador en diagonal y en la cabecera (BR4-FC1, Q6 A). */
export class PdfLibInvoiceRenderer implements InvoiceRenderer {
  async render(inv: DraftInvoice): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setTitle(`Borrador de factura ${inv.orderRef}`);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([595, 842]);

    // Marca de agua en diagonal.
    page.drawText('BORRADOR', {
      x: 110,
      y: 300,
      size: 110,
      font: bold,
      color: rgb(0.85, 0.85, 0.85),
      rotate: degrees(40),
    });

    let y = 790;
    const line = (text: string, opts: { size?: number; bold?: boolean } = {}) => {
      page.drawText(text, {
        x: 50,
        y,
        size: opts.size ?? 11,
        font: opts.bold ? bold : font,
        color: rgb(0, 0, 0),
      });
      y -= (opts.size ?? 11) + 7;
    };

    line(DRAFT_MARK, { size: 14, bold: true });
    line(`Pedido ${inv.orderRef} · ${formatMadrid(inv.issuedAt)}`);
    y -= 10;
    line('Emisora', { bold: true });
    line(inv.artistName);
    line(inv.artistEmail);
    line(inv.artistAddress);
    line('NIF: pendiente de completar');
    y -= 10;
    line('Intermediaria', { bold: true });
    line(inv.platformName);
    y -= 14;
    line('Concepto', { bold: true });
    line(`${inv.title}: ${eur(inv.workCents)}`);
    line(`Envío: ${eur(inv.shippingCents)}`);
    y -= 6;
    line(`Total: ${eur(inv.totalCents)}`, { size: 13, bold: true });
    y -= 20;
    line('Documento informativo. No sustituye a una factura.', { size: 9 });
    page.drawText(DRAFT_MARK, { x: 50, y: 30, size: 9, font: bold, color: rgb(0.4, 0.4, 0.4) });

    return doc.save();
  }
}
