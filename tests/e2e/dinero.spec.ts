import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * E2E de U5 (modo E2E_ENABLED: Stripe, Packlink y Resend simulados, Postgres real). La entrega se
 * simula en /e2e/envio/<ref>; la liquidacion la hace el trabajo `retry_settlements`, que el
 * endpoint interno encola en cada llamada (sin pg_cron).
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
  activatePayouts = true,
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
  void activatePayouts;

  await page.goto('/artista/enlaces/nuevo');
  await page
    .getByTestId('fotos-input')
    .setInputFiles({ name: 'obra.jpg', mimeType: 'image/jpeg', buffer: await photo() });
  await expect(page.getByTestId('fotos-item-1')).toContainText('Lista');
  await page.getByTestId('enlace-titulo-input').fill('Óleo sobre lienzo');
  await page.getByTestId('enlace-precio-input').fill('250');
  await page.getByTestId('enlace-tamano-radio-m').check();
  await page.getByTestId('enlace-origen-punto-check').check();
  await page.getByTestId('enlace-guardar-button').click();
  await expect(page.getByTestId('detalle-creado')).toBeVisible();
  const dm = await page.getByTestId('dm-texto-textarea').inputValue();
  return new URL(dm.split('\n').at(-1) ?? '').pathname;
}

async function buyAndPay(browser: Browser, path: string): Promise<void> {
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
  await context.close();
}

async function firstOrderId(page: Page): Promise<string> {
  await page.goto('/artista/pedidos');
  await page.getByTestId('pedido-ver').first().click();
  await page.waitForURL(/\/artista\/pedidos\/[0-9a-f-]{36}/);
  return page.url().split('/artista/pedidos/')[1] ?? '';
}

const refOf = (orderId: string): string =>
  `PL${orderId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;

async function deliver(page: Page, request: APIRequestContext, orderId: string): Promise<void> {
  await page.goto(`/e2e/envio/${refOf(orderId)}`);
  await page.getByTestId('e2e-envio-etiqueta').click();
  await expect(page.getByTestId('e2e-envio-estado')).toContainText('etiqueta');
  await page.getByTestId('e2e-envio-transito').click();
  await expect(page.getByTestId('e2e-envio-estado')).toContainText('transito');
  await page.getByTestId('e2e-envio-entregado').click();
  await expect(page.getByTestId('e2e-envio-estado')).toContainText('entregado');
  await runJobs(request, 4);
}

test.describe('Dinero (US-045 a US-049)', () => {
  test('retención al pagar, liquidación al entregar y retirada con confirmación en dos pasos', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request);
    await buyAndPay(browser, path);
    await runJobs(request);

    // Tras el pago el dinero está retenido y se explica por qué.
    await page.goto('/artista/dinero');
    await expect(page.getByTestId('dinero-retenido')).toContainText('250,00');
    await expect(page.getByTestId('dinero-disponible')).toContainText('0,00');
    await expect(page.getByTestId('dinero-retenido-motivo')).toContainText('Esperando la etiqueta');

    const orderId = await firstOrderId(page);
    await expect(page.getByTestId('pedido-dinero')).toContainText('en retención');
    await deliver(page, request, orderId);

    await page.goto('/artista/dinero');
    await expect(page.getByTestId('dinero-disponible')).toContainText('250,00');
    await expect(page.getByTestId('dinero-retenido')).toContainText('0,00');
    await page.goto(`/artista/pedidos/${orderId}`);
    await expect(page.getByTestId('pedido-dinero')).toContainText('Cobro liberado');

    // Retirada: la primera pulsación solo pide confirmar; la segunda la envía.
    await page.goto('/artista/dinero');
    await page.getByTestId('dinero-retirar-button').click();
    await expect(page.getByTestId('dinero-confirmar-texto')).toContainText('250,00');
    await page.getByTestId('dinero-cancelar-button').click();
    await expect(page.getByTestId('dinero-retirar-button')).toBeVisible();
    await page.getByTestId('dinero-retirar-button').click();
    await page.getByTestId('dinero-confirmar-button').click();
    await expect(page.getByTestId('dinero-ok')).toBeVisible();
    await expect(page.getByTestId('dinero-disponible')).toContainText('0,00');
    await expect(page.getByTestId('dinero-retirada-item')).toHaveCount(1);
    // Sin saldo ya no hay nada que retirar (una segunda pulsación no crea otra retirada).
    await expect(page.getByTestId('dinero-retirar-desactivado')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('otra artista no ve el dinero ni el pedido de la primera', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request);
    await buyAndPay(browser, path);
    await runJobs(request);

    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await signIn(other, ctx.request, uniqueEmail('intrusa'));
    await other.goto('/artista/dinero');
    await expect(other.getByTestId('dinero-retenido')).toContainText('0,00');
    await expect(other.getByTestId('dinero-retenido-vacio')).toBeVisible();
    await ctx.close();
  });
});
