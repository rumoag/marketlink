import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * E2E de U4 (modo E2E_ENABLED: Stripe, Packlink y Resend simulados, Postgres real). El «panel de
 * Packlink» es /e2e/envio/<ref>; la cola se ejecuta con el endpoint interno de trabajos.
 */
const SECRET = process.env.INTERNAL_JOBS_SECRET ?? '';
let counter = 0;
const uniqueEmail = (name: string) => `${name}-${Date.now()}-${counter++}@example.com`;

const photo = () =>
  sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 90, b: 160 } } })
    .jpeg({ quality: 90 })
    .toBuffer();

async function runJobs(request: APIRequestContext, times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    const res = await request.post('/api/internal/jobs/run', {
      headers: { 'x-internal-secret': SECRET },
    });
    expect(res.status()).toBe(200);
  }
}

async function signIn(page: Page, request: APIRequestContext, email: string): Promise<void> {
  const res = await request.post('/api/test/sign-in-link', {
    headers: { 'x-internal-secret': SECRET },
    data: { email },
  });
  await page.goto(((await res.json()) as { url: string }).url);
  await page.getByTestId('confirmar-entrar-button').click();
  await expect(page).toHaveURL(/\/artista$/);
}

async function publishedListing(
  page: Page,
  request: APIRequestContext,
  modality: 'punto' | 'recogida',
): Promise<string> {
  await signIn(page, request, uniqueEmail('artista'));
  await page.goto('/artista/perfil');
  await page.getByTestId('perfil-nombre-input').fill('Ana Art');
  await page.getByTestId('perfil-instagram-input').fill('@Ana.Art');
  await page.getByTestId('perfil-telefono-input').fill('612 345 678');
  await page.getByTestId('perfil-guardar-button').click();
  await expect(page.getByTestId('perfil-guardado')).toBeVisible();
  await page.goto('/artista/direccion');
  await page.getByTestId('direccion-calle-input').fill('Calle Mayor');
  await page.getByTestId('direccion-numero-input').fill('12');
  await page.getByTestId('direccion-cp-input').fill('28001');
  await page.getByTestId('direccion-ciudad-input').fill('Madrid');
  await page.getByTestId('direccion-provincia-input').fill('Madrid');
  await page.getByTestId('direccion-telefono-input').fill('612345678');
  await page.getByTestId('direccion-guardar-button').click();
  await expect(page.getByTestId('direccion-guardada')).toBeVisible();
  await page.goto('/artista/cobros');
  await page.getByTestId('cobros-activar-button').click();
  await expect(page.getByTestId('cobros-estado-text')).toHaveText('Cobros activos');

  await page.goto('/artista/enlaces/nuevo');
  await page
    .getByTestId('fotos-input')
    .setInputFiles({ name: 'obra.jpg', mimeType: 'image/jpeg', buffer: await photo() });
  await expect(page.getByTestId('fotos-item-1')).toContainText('Lista');
  await page.getByTestId('enlace-titulo-input').fill('Óleo sobre lienzo');
  await page.getByTestId('enlace-precio-input').fill('250');
  await page.getByTestId('enlace-tamano-radio-m').check();
  await page.getByTestId(`enlace-origen-${modality}-check`).check();
  await page.getByTestId('enlace-guardar-button').click();
  await expect(page.getByTestId('detalle-creado')).toBeVisible();
  const dm = await page.getByTestId('dm-texto-textarea').inputValue();
  return new URL(dm.split('\n').at(-1) ?? '').pathname;
}

async function buyAndPay(browser: Browser, path: string): Promise<{ trackingPath: string }> {
  const context = await browser.newContext();
  const b = await context.newPage();
  await b.goto(path);
  await b.getByTestId('compra-nombre-input').fill('Lucía García');
  await b.getByTestId('compra-email-input').fill(uniqueEmail('lucia'));
  await b.getByTestId('compra-telefono-input').fill('612 345 678');
  await b.getByTestId('compra-calle-input').fill('Calle Sol 4');
  await b.getByTestId('compra-cp-input').fill('08001');
  await b.getByTestId('compra-localidad-input').fill('Barcelona');
  await b.getByTestId('compra-provincia-input').fill('Barcelona');
  await b.getByTestId('compra-calcular-button').click();
  await expect(b.getByTestId('resumen-total')).toBeVisible();
  await b.getByTestId('compra-acepto-check').check();
  await b.getByTestId('compra-pagar-button').click();
  await b.getByTestId('e2e-pagar').click();
  const href = await b.getByTestId('exito-seguimiento-link').getAttribute('href');
  await context.close();
  return { trackingPath: href ?? '' };
}

/** Id del pedido de la primera fila de la lista de la artista. */
async function firstOrderId(page: Page): Promise<string> {
  await page.goto('/artista/pedidos');
  await page.getByTestId('pedido-ver').first().click();
  await page.waitForURL(/\/artista\/pedidos\/[0-9a-f-]{36}/);
  return page.url().split('/artista/pedidos/')[1] ?? '';
}

const refOf = (orderId: string): string =>
  `PL${orderId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;

test.describe('Envío (US-026 a US-038)', () => {
  test('del pago a la entrega: borrador, etiqueta con sesión, puntos, factura y seguimiento', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request, 'punto');
    const { trackingPath } = await buyAndPay(browser, path);
    await runJobs(request);

    const orderId = await firstOrderId(page);
    await expect(page.getByTestId('pedido-siguiente')).toContainText('Preparando tu etiqueta');
    await expect(page.getByTestId('pedido-direccion')).toContainText('Calle Sol 4');

    // Packlink avisa de que la etiqueta está lista y luego del tránsito.
    const ref = refOf(orderId);
    await page.goto(`/e2e/envio/${ref}`);
    await page.getByTestId('e2e-envio-etiqueta').click();
    await expect(page.getByTestId('e2e-envio-estado')).toContainText('etiqueta');
    await runJobs(request);
    await page.goto(`/artista/pedidos/${orderId}`);
    await expect(page.getByTestId('pedido-siguiente')).toContainText('Lleva el paquete a un punto');
    await expect(page.getByTestId('pedido-puntos').locator('li')).toHaveCount(3);

    // La etiqueta solo se descarga con sesión; el PDF llega por redirección.
    const label = await page.request.get(`/artista/pedidos/${orderId}/etiqueta`);
    expect(label.status()).toBe(200);
    expect(label.headers()['content-type']).toContain('application/pdf');
    const anonymous = await request.get(`/artista/pedidos/${orderId}/etiqueta`, {
      maxRedirects: 0,
    });
    expect(anonymous.status()).not.toBe(200);

    const invoice = await page.request.get(`/artista/pedidos/${orderId}/factura`);
    expect(invoice.status()).toBe(200);
    expect(invoice.headers()['content-type']).toContain('application/pdf');

    await page.goto(`/e2e/envio/${ref}`);
    await page.getByTestId('e2e-envio-transito').click();
    await expect(page.getByTestId('e2e-envio-estado')).toContainText('transito');
    await page.getByTestId('e2e-envio-entregado').click();
    await expect(page.getByTestId('e2e-envio-estado')).toContainText('entregado');
    await runJobs(request);

    await page.goto(`/artista/pedidos/${orderId}`);
    await expect(page.getByTestId('pedido-siguiente')).toContainText('Entregado');
    await expect(page.getByTestId('pedido-direccion')).toHaveCount(0); // ya solo la localidad

    // La compradora ve el historial y el enlace del transportista, sin datos personales.
    const ctx = await browser.newContext();
    const buyer = await ctx.newPage();
    await buyer.goto(trackingPath);
    await expect(buyer.getByTestId('seguimiento-estado')).toContainText('Entregado');
    await expect(buyer.getByTestId('seguimiento-historial')).toContainText('En camino');
    await expect(buyer.getByTestId('seguimiento-transportista')).toBeVisible();
    await expect(buyer.locator('body')).not.toContainText('Calle Sol');
    await ctx.close();
  });

  test('en recogida la artista elige fecha y franja y entonces se crea el borrador', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request, 'recogida');
    await buyAndPay(browser, path);
    await runJobs(request);

    const orderId = await firstOrderId(page);
    await expect(page.getByTestId('pedido-siguiente')).toContainText('Elige la recogida');
    const option = page.locator('[data-testid^="recogida-"][type="radio"]').first();
    await option.check();
    await page.getByTestId('recogida-confirmar-button').click();
    await expect(page.getByTestId('pedido-recogida-mensaje')).toContainText('Recogida elegida');
    await runJobs(request);

    await page.goto(`/artista/pedidos/${orderId}`);
    await expect(page.getByTestId('pedido-recogida-elegida')).toBeVisible();
    await expect(page.getByTestId('pedido-siguiente')).toContainText('Preparando tu etiqueta');
  });

  test('un fallo del transportista muestra un mensaje tranquilizador y no reembolsa', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request, 'punto');
    const { trackingPath } = await buyAndPay(browser, path);
    await runJobs(request);
    const orderId = await firstOrderId(page);

    await page.goto(`/e2e/envio/${refOf(orderId)}`);
    await page.getByTestId('e2e-envio-etiqueta').click();
    await expect(page.getByTestId('e2e-envio-estado')).toContainText('etiqueta');
    await page.getByTestId('e2e-envio-fallo_transportista').click();
    await expect(page.getByTestId('e2e-envio-estado')).toContainText('fallo_transportista');
    await runJobs(request);

    await page.goto(`/artista/pedidos/${orderId}`);
    await expect(page.getByTestId('pedido-siguiente')).toContainText('Estamos revisándolo');

    const ctx = await browser.newContext();
    const buyer = await ctx.newPage();
    await buyer.goto(trackingPath);
    await expect(buyer.getByTestId('seguimiento-estado')).toContainText('Reembolso');
    await ctx.close();
  });

  test('otra artista no ve ni descarga el pedido, la etiqueta ni la factura', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request, 'punto');
    await buyAndPay(browser, path);
    await runJobs(request);
    const orderId = await firstOrderId(page);
    await page.goto(`/e2e/envio/${refOf(orderId)}`);
    await page.getByTestId('e2e-envio-etiqueta').click();

    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await signIn(other, ctx.request, uniqueEmail('intrusa'));
    for (const suffix of ['', '/etiqueta', '/factura']) {
      const res = await other.request.get(`/artista/pedidos/${orderId}${suffix}`);
      expect(res.status()).toBe(404);
    }
    await ctx.close();
  });

  test('accesibilidad del detalle del pedido', async ({ page, request, browser }) => {
    const path = await publishedListing(page, request, 'punto');
    await buyAndPay(browser, path);
    await runJobs(request);
    await firstOrderId(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
  });
});
