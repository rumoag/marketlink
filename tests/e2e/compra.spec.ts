import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * E2E de U3 (modo E2E_ENABLED: Stripe y Packlink simulados, Postgres real). La «pagina de Stripe»
 * es /e2e/pago/<sesion>. Codigos postales de prueba: 08001 normal, 26001 solo recogida,
 * 44001 sin servicio, 42001 proveedor caido.
 */
const SECRET = process.env.INTERNAL_JOBS_SECRET ?? '';
let counter = 0;
const uniqueEmail = (name: string) => `${name}-${Date.now()}-${counter++}@example.com`;

const photo = () =>
  sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 90, b: 160 } } })
    .jpeg({ quality: 90 })
    .toBuffer();

async function signIn(page: Page, request: APIRequestContext, email: string): Promise<void> {
  const res = await request.post('/api/test/sign-in-link', {
    headers: { 'x-internal-secret': SECRET },
    data: { email },
  });
  const url = ((await res.json()) as { url: string }).url;
  await page.goto(url);
  await page.getByTestId('confirmar-entrar-button').click();
  await expect(page).toHaveURL(/\/artista$/);
}

/** Artista lista para vender y una obra publicada; devuelve la ruta publica. */
async function publishedListing(
  page: Page,
  request: APIRequestContext,
  modality: 'punto' | 'recogida' = 'punto',
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
  await page.getByTestId(`enlace-modalidad-radio-${modality}`).check();
  await page.getByTestId('enlace-guardar-button').click();
  await expect(page.getByTestId('detalle-creado')).toBeVisible();
  const dm = await page.getByTestId('dm-texto-textarea').inputValue();
  const link = dm.split('\n').at(-1) ?? '';
  return new URL(link).pathname;
}

/** Una compradora anonima en un contexto aparte (sin la sesion de la artista). */
async function buyer(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function fillBuyer(page: Page, postalCode = '08001', province = 'Barcelona'): Promise<void> {
  await page.getByTestId('compra-nombre-input').fill('Lucía García');
  await page.getByTestId('compra-email-input').fill(uniqueEmail('lucia'));
  await page.getByTestId('compra-telefono-input').fill('612 345 678');
  await page.getByTestId('compra-calle-input').fill('Calle Sol 4');
  await page.getByTestId('compra-cp-input').fill(postalCode);
  await page.getByTestId('compra-localidad-input').fill('Barcelona');
  await page.getByTestId('compra-provincia-input').fill(province);
}

test.describe('Compra (US-015 a US-025)', () => {
  test('compra completa: total, pago, exito, seguimiento y enlace vendido', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request);
    const b = await buyer(browser);
    await b.page.goto(path);
    await expect(b.page.getByTestId('obra-titulo')).toHaveText('Óleo sobre lienzo');
    await expect(b.page.getByTestId('obra-precio')).toContainText('250');
    // La pagina publica nunca muestra datos de contacto de la artista.
    await expect(b.page.locator('body')).not.toContainText('612');

    await fillBuyer(b.page);
    await b.page.getByTestId('compra-calcular-button').click();
    await expect(b.page.getByTestId('resumen-envio')).toContainText('4,50');
    await expect(b.page.getByTestId('resumen-total')).toContainText('254,50');

    await b.page.getByTestId('compra-acepto-check').check();
    await b.page.getByTestId('compra-pagar-button').click();
    await expect(b.page).toHaveURL(/\/e2e\/pago\//);
    await expect(b.page.getByTestId('e2e-pago-importe')).toContainText('254,50');
    await b.page.getByTestId('e2e-pagar').click();

    await expect(b.page.getByTestId('exito-titulo')).toHaveText(
      'Pago recibido. Te avisaremos cuando salga el envío.',
    );
    await b.page.getByTestId('exito-seguimiento-link').click();
    await expect(b.page.getByTestId('seguimiento-estado')).toContainText('Pago recibido');
    await expect(b.page.locator('body')).not.toContainText('Lucía');
    await expect(b.page.locator('body')).not.toContainText('Calle Sol');

    // Una segunda visita ve la obra vendida, sin formulario.
    await b.page.goto(path);
    await expect(b.page.getByTestId('obra-aviso')).toContainText('vendido');
    await expect(b.page.getByTestId('compra-form')).toHaveCount(0);

    // La artista ve el pedido, con la localidad pero sin la direccion.
    await page.goto('/artista/pedidos');
    await expect(page.getByTestId('pedido-estado').first()).toContainText('Pago recibido');
    await expect(page.locator('body')).not.toContainText('Calle Sol');
    await b.context.close();
  });

  test('un codigo postal sin servicio, con proveedor caido o fuera de la peninsula no deja pagar', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request);
    const b = await buyer(browser);
    await b.page.goto(path);
    await fillBuyer(b.page, '44001', 'Teruel');
    await b.page.getByTestId('compra-calcular-button').click();
    await expect(b.page.getByTestId('compra-error')).toContainText('No podemos calcular el envío');

    await b.page.getByTestId('compra-cp-input').fill('42001');
    await b.page.getByTestId('compra-provincia-input').fill('Soria');
    await b.page.getByTestId('compra-calcular-button').click();
    await expect(b.page.getByTestId('compra-error')).toContainText('No podemos calcular el envío');

    await b.page.getByTestId('compra-cp-input').fill('07001');
    await b.page.getByTestId('compra-calcular-button').click();
    await expect(b.page.getByRole('alert').first()).toBeVisible();
    await expect(b.page.getByTestId('compra-resumen')).toHaveCount(0);
    await b.context.close();
  });

  test('la alternativa de envio exige aceptarla', async ({ page, request, browser }) => {
    const path = await publishedListing(page, request, 'punto');
    const b = await buyer(browser);
    await b.page.goto(path);
    await fillBuyer(b.page, '26001', 'La Rioja');
    await b.page.getByTestId('compra-calcular-button').click();
    await expect(b.page.getByTestId('compra-alternativa')).toBeVisible();
    await expect(b.page.getByTestId('resumen-envio')).toContainText('6,20');
    await b.page.getByTestId('compra-acepto-check').check();
    await b.page.getByTestId('compra-pagar-button').click();
    await expect(b.page.getByTestId('compra-error')).toContainText('alternativa');
    await b.page.getByTestId('compra-alternativa-check').check();
    await b.page.getByTestId('compra-pagar-button').click();
    await expect(b.page).toHaveURL(/\/e2e\/pago\//);
    await b.context.close();
  });

  test('sin aceptar las condiciones no se paga', async ({ page, request, browser }) => {
    const path = await publishedListing(page, request);
    const b = await buyer(browser);
    await b.page.goto(path);
    await fillBuyer(b.page);
    await b.page.getByTestId('compra-calcular-button').click();
    await b.page.getByTestId('compra-pagar-button').click();
    await expect(b.page.getByRole('alert').first()).toBeVisible();
    await expect(b.page).not.toHaveURL(/\/e2e\/pago\//);
    await b.context.close();
  });

  test('mientras alguien paga, otra persona ve la obra reservada; al cancelar se libera y el formulario se rellena', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request);
    const b = await buyer(browser);
    await b.page.goto(path);
    await fillBuyer(b.page);
    await b.page.getByTestId('compra-calcular-button').click();
    await expect(b.page.getByTestId('resumen-total')).toBeVisible();
    await b.page.getByTestId('compra-acepto-check').check();
    await b.page.getByTestId('compra-pagar-button').click();
    await expect(b.page).toHaveURL(/\/e2e\/pago\//);

    const other = await buyer(browser);
    await other.page.goto(path);
    await expect(other.page.getByTestId('obra-aviso')).toContainText('reservada');

    await b.page.getByTestId('e2e-cancelar').click();
    await expect(b.page).toHaveURL(new RegExp(`${path}$`));
    await expect(b.page.getByTestId('compra-nombre-input')).toHaveValue('Lucía García');
    await expect(b.page.getByTestId('compra-acepto-check')).not.toBeChecked();

    await other.page.reload();
    await expect(other.page.getByTestId('compra-form')).toBeVisible(); // la obra vuelve a estar libre
    await b.context.close();
    await other.context.close();
  });

  test('seguimiento: un token inventado da la respuesta generica', async ({ page }) => {
    await page.goto(`/seguimiento/${'a'.repeat(43)}`);
    await expect(page.getByTestId('seguimiento-desconocido')).toBeVisible();
    await page.goto('/seguimiento/corto');
    await expect(page.getByTestId('seguimiento-desconocido')).toBeVisible();
  });

  test('el modo manual esta apagado: la pagina no ofrece Bizum directo', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request);
    const b = await buyer(browser);
    await b.page.goto(path);
    await expect(b.page.getByTestId('compra-manual-button')).toHaveCount(0);
    await b.context.close();
  });

  test('textos legales provisionales visibles y accesibles', async ({ page }) => {
    for (const route of ['/privacidad', '/condiciones']) {
      await page.goto(route);
      await expect(page.getByTestId('legal-borrador')).toContainText('pendiente de revisión legal');
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
      ).toEqual([]);
    }
  });

  test('axe y cabeceras en la pagina publica de la obra', async ({ page, request, browser }) => {
    const path = await publishedListing(page, request);
    const b = await buyer(browser);
    const res = await b.page.goto(path);
    expect(res?.headers()['cache-control']).toContain('no-store');
    expect(res?.headers()['content-security-policy']).toContain("default-src 'self'");
    await fillBuyer(b.page);
    await b.page.getByTestId('compra-calcular-button').click();
    await expect(b.page.getByTestId('compra-resumen')).toBeVisible();
    const results = await new AxeBuilder({ page: b.page }).analyze();
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
    await b.context.close();
  });
});
