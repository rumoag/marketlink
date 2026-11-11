import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * E2E de U3 (modo E2E_ENABLED: Stripe y Packlink simulados, Postgres real). La «pagina de Stripe»
 * es /e2e/pago/<sesion>. Codigos postales de prueba: 08001 normal, 26001 solo recogida,
 * 44001 sin servicio, 42001 proveedor caido, 43001 sin puntos de recogida.
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
  modality: 'punto' | 'recogida' | 'ambos' = 'punto',
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
  for (const origin of modality === 'ambos' ? (['punto', 'recogida'] as const) : [modality]) {
    await page.getByTestId(`enlace-origen-${origin}-check`).check();
  }
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
  test('el envio se calcula solo al escribir el codigo postal, sin pulsar nada y sin perder lo escrito', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request);
    const b = await buyer(browser);
    await b.page.goto(path);
    // Se rellena el formulario entero SIN pulsar «Calcular envio»: el codigo postal va antes que la
    // localidad y la provincia, que se escriben mientras el calculo esta en marcha.
    await fillBuyer(b.page);
    await expect(b.page.getByTestId('resumen-total')).toBeVisible({ timeout: 10_000 });
    await expect(b.page.getByTestId('resumen-envio')).toContainText('€');
    // Lo escrito sigue ahi: el calculo en segundo plano no reinicia el formulario.
    await expect(b.page.getByTestId('compra-nombre-input')).toHaveValue('Lucía García');
    await expect(b.page.getByTestId('compra-localidad-input')).toHaveValue('Barcelona');
    await expect(b.page.getByTestId('compra-provincia-input')).toHaveValue('Barcelona');
    // Y se puede pagar con ese total.
    await b.page.getByTestId('compra-acepto-check').check();
    await b.page.getByTestId('compra-pagar-button').click();
    await expect(b.page).toHaveURL(/\/e2e\/pago\//);
    await b.context.close();
  });

  test('un codigo postal sin servicio avisa solo, sin pulsar el boton', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request);
    const b = await buyer(browser);
    await b.page.goto(path);
    await fillBuyer(b.page, '07001', 'Baleares');
    await expect(b.page.getByRole('alert').first()).toBeVisible({ timeout: 10_000 });
    await expect(b.page.getByTestId('compra-resumen')).toHaveCount(0);
    await b.context.close();
  });

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
    // Otro test en paralelo puede procesar la cola y adelantar el borrador del envio.
    await expect(page.getByTestId('pedido-estado').first()).toContainText(
      /Pago recibido|Preparando el envío/,
    );
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
    await expect(b.page.getByTestId('compra-error')).toContainText('No hay envío posible');

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

  test('sin servicio de los origenes aceptados no hay envio ni alternativa (BR8-S1)', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request, 'punto');
    const b = await buyer(browser);
    await b.page.goto(path);
    await fillBuyer(b.page, '26001', 'La Rioja');
    await b.page.getByTestId('compra-calcular-button').click();
    await expect(b.page.getByTestId('compra-error')).toContainText('No hay envío posible');
    await expect(b.page.getByTestId('compra-opciones')).toHaveCount(0);
    await b.context.close();
  });

  test('opciones agrupadas con precio: se preselecciona la mas barata a domicilio y el total cambia al elegir otra', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request, 'ambos');
    const b = await buyer(browser);
    await b.page.goto(path);
    await fillBuyer(b.page);
    await expect(b.page.getByTestId('compra-opciones')).toBeVisible({ timeout: 10_000 });
    await expect(b.page.getByTestId('compra-grupo-domicilio')).toBeVisible();
    await expect(b.page.getByTestId('compra-grupo-punto')).toBeVisible();
    // Preseleccionada: la mas barata a domicilio (Correos, 4,50 €).
    await expect(b.page.getByTestId('compra-opcion-9003')).toBeChecked();
    await expect(b.page.getByTestId('resumen-total')).toContainText('254,50');
    // Elegir otra a domicilio actualiza el total al momento.
    await b.page.getByTestId('compra-opcion-9002').check();
    await expect(b.page.getByTestId('resumen-total')).toContainText('254,90');
    // Y la de recogida en casa (6,20 €).
    await b.page.getByTestId('compra-opcion-9001').check();
    await expect(b.page.getByTestId('resumen-total')).toContainText('256,20');
    await b.context.close();
  });

  test('elegir una opcion con entrega en punto: lista de puntos, Mostrar mas y pago con el punto', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request, 'ambos');
    const b = await buyer(browser);
    await b.page.goto(path);
    await fillBuyer(b.page);
    await expect(b.page.getByTestId('compra-opciones')).toBeVisible({ timeout: 10_000 });
    await b.page.getByTestId('compra-opcion-9004').check();
    await expect(b.page.getByTestId('compra-selector-punto')).toBeVisible();
    // Sin punto elegido no se puede pagar.
    await expect(b.page.getByTestId('compra-pagar-button')).toBeDisabled();
    await expect(b.page.getByTestId('compra-falta-punto')).toBeVisible();
    // Diez puntos y «Mostrar mas» hasta los doce.
    await expect(b.page.getByTestId('compra-punto-P9004-01')).toBeVisible();
    // Accesibilidad de las opciones y de la lista de puntos (EN-19).
    const axe = await new AxeBuilder({ page: b.page }).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
      [],
    );
    await expect(b.page.getByTestId('compra-punto-P9004-10')).toBeVisible();
    await expect(b.page.getByTestId('compra-punto-P9004-11')).toHaveCount(0);
    await b.page.getByTestId('compra-mostrar-mas-puntos').click();
    await expect(b.page.getByTestId('compra-punto-P9004-12')).toBeVisible();
    await b.page.getByTestId('compra-punto-P9004-03').check();
    await expect(b.page.getByTestId('compra-pagar-button')).toBeEnabled();
    await expect(b.page.getByTestId('resumen-total')).toContainText('253,90');
    // Cambiar de opcion descarta el punto elegido.
    await b.page.getByTestId('compra-opcion-9003').check();
    await expect(b.page.getByTestId('compra-selector-punto')).toHaveCount(0);
    await b.page.getByTestId('compra-opcion-9004').check();
    await expect(b.page.getByTestId('compra-punto-P9004-03')).not.toBeChecked();
    await b.page.getByTestId('compra-punto-P9004-03').check();

    await b.page.getByTestId('compra-acepto-check').check();
    await b.page.getByTestId('compra-pagar-button').click();
    await expect(b.page).toHaveURL(/\/e2e\/pago\//);
    await expect(b.page.getByTestId('e2e-pago-importe')).toContainText('253,90');
    await b.page.getByTestId('e2e-pagar').click();
    await expect(b.page.getByTestId('exito-titulo')).toBeVisible();
    await b.page.getByTestId('exito-seguimiento-link').click();
    await expect(b.page.getByTestId('seguimiento-servicio')).toContainText('Correos');
    await expect(b.page.getByTestId('seguimiento-punto')).toContainText('Punto 03');

    // La artista ve como se envia y a que punto (US-065).
    await page.goto('/artista/pedidos');
    await page.getByTestId('pedido-ver').first().click();
    await expect(page.getByTestId('pedido-servicio')).toContainText('Correos');
    await expect(page.getByTestId('pedido-destino')).toContainText('Punto 03');
    await b.context.close();
  });

  test('un codigo postal sin puntos de recogida avisa y no deja pagar con ese servicio', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request, 'ambos');
    const b = await buyer(browser);
    await b.page.goto(path);
    await fillBuyer(b.page, '43001', 'Tarragona');
    await expect(b.page.getByTestId('compra-opciones')).toBeVisible({ timeout: 10_000 });
    await b.page.getByTestId('compra-opcion-9004').check();
    await expect(b.page.getByTestId('compra-punto-error')).toContainText('No hay puntos');
    await expect(b.page.getByTestId('compra-pagar-button')).toBeDisabled();
    // Con una opcion a domicilio se puede pagar.
    await b.page.getByTestId('compra-opcion-9003').check();
    await expect(b.page.getByTestId('compra-pagar-button')).toBeEnabled();
    await b.context.close();
  });

  test('cambiar el codigo postal recalcula y descarta lo elegido', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request, 'ambos');
    const b = await buyer(browser);
    await b.page.goto(path);
    await fillBuyer(b.page);
    await expect(b.page.getByTestId('compra-opciones')).toBeVisible({ timeout: 10_000 });
    await b.page.getByTestId('compra-opcion-9001').check();
    await b.page.getByTestId('compra-cp-input').fill('26001');
    await b.page.getByTestId('compra-provincia-input').fill('La Rioja');
    // En La Rioja solo hay recogida: queda esa, preseleccionada de nuevo.
    await expect(b.page.getByTestId('compra-opcion-9001')).toBeChecked({ timeout: 10_000 });
    await expect(b.page.getByTestId('compra-opcion-9003')).toHaveCount(0);
    await b.page.getByTestId('compra-cp-input').fill('44001');
    await b.page.getByTestId('compra-provincia-input').fill('Teruel');
    await expect(b.page.getByTestId('compra-error')).toContainText('No hay envío posible', {
      timeout: 10_000,
    });
    await expect(b.page.getByTestId('compra-opciones')).toHaveCount(0);
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
    // Al volver con el formulario relleno, el envio se calcula solo.
    await expect(b.page.getByTestId('resumen-total')).toBeVisible({ timeout: 10_000 });
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
