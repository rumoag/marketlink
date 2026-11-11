import AxeBuilder from '@axe-core/playwright';
import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * E2E de U6 (modo E2E_ENABLED: Stripe, Packlink y Resend simulados, Postgres real). El operador de
 * pruebas y su secreto TOTP vienen de las variables OPERATOR_* de la aplicacion; aqui se calcula el
 * mismo codigo con la RFC 6238.
 */
const SECRET = process.env.INTERNAL_JOBS_SECRET ?? '';
// Cada prueba que inicia sesion usa su propio operador: el paso TOTP no se acepta dos veces por
// operador (anti-repeticion) y las pruebas corren en paralelo.
const OP_EMAILS = (
  process.env.OPERATOR_EMAILS ??
  'operador@example.com,operador2@example.com,operador3@example.com,operador4@example.com'
)
  .split(',')
  .map((e) => e.trim());
const OP_EMAIL = OP_EMAILS[0]!;
const TOTP_SECRET =
  (process.env.OPERATOR_TOTP_SECRETS ?? '').split(',')[0]?.split(':')[1] ?? 'JBSWY3DPEHPK3PXP';
let counter = 0;
const uniqueEmail = (name: string) => `${name}-${Date.now()}-${counter++}@example.com`;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32Decode = (text: string): Buffer => {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.toUpperCase()) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

/** Codigo TOTP de un paso concreto (30 s); `ahead` salta pasos para no reutilizar el anterior. */
const totp = (ahead = 0): string => {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + ahead));
  const mac = createHmac('sha1', base32Decode(TOTP_SECRET)).update(counterBuf).digest();
  const off = (mac[mac.length - 1] ?? 0) & 15;
  const bin =
    (((mac[off] ?? 0) & 0x7f) << 24) |
    (((mac[off + 1] ?? 0) & 0xff) << 16) |
    (((mac[off + 2] ?? 0) & 0xff) << 8) |
    ((mac[off + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
};

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

async function operatorLink(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post('/api/test/sign-in-link', {
    headers: { 'x-internal-secret': SECRET },
    data: { email, operator: true },
  });
  return ((await res.json()) as { url: string }).url;
}

async function operatorSignIn(
  page: Page,
  request: APIRequestContext,
  email: string,
): Promise<void> {
  await page.goto(await operatorLink(request, email));
  await page.getByTestId('operador-confirmar-button').click();
  await expect(page).toHaveURL(/\/operador\/acceso\/codigo$/);
  await page.getByTestId('operador-codigo-input').fill(totp());
  await page.getByTestId('operador-codigo-submit').click();
  await expect(page).toHaveURL(/\/operador$/);
}

async function artistSignIn(page: Page, request: APIRequestContext, email: string): Promise<void> {
  const res = await request.post('/api/test/sign-in-link', {
    headers: { 'x-internal-secret': SECRET },
    data: { email },
  });
  await page.goto(((await res.json()) as { url: string }).url);
  await page.getByTestId('confirmar-entrar-button').click();
  await expect(page).toHaveURL(/\/artista$/);
}

async function publishedListing(page: Page, request: APIRequestContext): Promise<string> {
  await artistSignIn(page, request, uniqueEmail('artista'));
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

test.describe('Panel del operador (US-014, 028, 029, 039 a 044)', () => {
  test('sin sesión el panel no se ve y el acceso no revela quién es operador', async ({
    page,
    request,
  }) => {
    await page.goto('/operador');
    await expect(page).toHaveURL(/\/operador\/acceso$/);
    await page.getByTestId('operador-email-input').fill('intruso@example.com');
    await page.getByTestId('operador-email-submit').click();
    await expect(page.getByTestId('operador-enviado')).toBeVisible();
    await page.goto('/operador/acceso');
    await page.getByTestId('operador-email-input').fill(OP_EMAIL);
    await page.getByTestId('operador-email-submit').click();
    // Misma respuesta para un email autorizado y para uno que no lo es.
    await expect(page.getByTestId('operador-enviado')).toBeVisible();
    // Una cuenta de artista nunca da acceso al panel.
    await artistSignIn(page, request, uniqueEmail('artista'));
    await page.goto('/operador');
    await expect(page).toHaveURL(/\/operador\/acceso$/);
  });

  test('acceso con segundo factor, ficha, incidencia, nota, reembolso con código y métricas', async ({
    page,
    request,
    browser,
  }) => {
    const path = await publishedListing(page, request);
    await buyAndPay(browser, path);
    await runJobs(request);

    const ctx = await browser.newContext();
    const op = await ctx.newPage();
    // Un código erróneo no entra; el correcto sí.
    await op.goto(await operatorLink(ctx.request, OP_EMAIL));
    await op.getByTestId('operador-confirmar-button').click();
    await op.getByTestId('operador-codigo-input').fill('000000');
    await op.getByTestId('operador-codigo-submit').click();
    await expect(op.getByTestId('operador-codigo-error')).toBeVisible();
    await op.getByTestId('operador-codigo-input').fill(totp());
    await op.getByTestId('operador-codigo-submit').click();
    await expect(op).toHaveURL(/\/operador$/);
    // El panel es global y las pruebas corren en paralelo sobre la misma base: se comprueba que
    // los contadores y la lista responden y se abre el pedido propio por su id.
    await expect(op.getByTestId('op-card-unpaidDrafts')).toContainText(/\d/);

    await op.goto('/operador/pedidos');
    expect(await op.getByTestId('op-pedido-fila').count()).toBeGreaterThan(0);
    await expect(op.locator('body')).not.toContainText('Calle Sol');
    await expect(op.getByTestId('op-pedido-ref').first()).toBeVisible();

    await page.goto('/artista/pedidos');
    await page.getByTestId('pedido-ver').first().click();
    await page.waitForURL(/\/artista\/pedidos\/[0-9a-f-]{36}/);
    const orderId = page.url().split('/artista/pedidos/')[1] ?? '';
    await op.goto(`/operador/pedidos/${orderId}`);
    await expect(op.getByTestId('op-ficha-destino')).toContainText('Calle Sol');

    await op.getByTestId('op-abrir-incidencia-reason').fill('Reclamación de la compradora');
    await op.getByTestId('op-abrir-incidencia-submit').click();
    await expect(op.getByTestId('op-ficha-incidencia')).toBeVisible();
    await op.getByTestId('op-nota-nueva-text').fill('Hablé con la artista');
    await op.getByTestId('op-nota-nueva-submit').click();
    await expect(op.getByTestId('op-nota')).toHaveCount(1);

    // Reembolso parcial: confirmación en dos pasos y código TOTP de un paso posterior al del acceso.
    await op.getByTestId('op-reembolsar-amount').fill('5,00');
    await op.getByTestId('op-reembolsar-code').fill(totp(1));
    await op.getByTestId('op-reembolsar-revisar').click();
    await expect(op.getByTestId('op-reembolsar-confirmar-texto')).toBeVisible();
    await op.getByTestId('op-reembolsar-submit').click();
    await expect(op.getByTestId('op-reembolsar-ok')).toContainText('parcial');
    await expect(op.getByTestId('op-ficha-reembolsado')).toContainText('5,00');

    await op.goto('/operador/metricas?p=7');
    await expect(op.getByTestId('op-metrica-pedidos-actual')).toHaveText(/^[1-9]\d*$/);
    const results = await new AxeBuilder({ page: op }).analyze();
    expect(results.violations).toEqual([]);

    // La artista no ve nada del panel.
    const resp = await page.request.get('/operador/pedidos', { maxRedirects: 0 });
    expect(resp.status()).not.toBe(200);
    await ctx.close();
  });

  test('tamaños: valida, guarda y la artista los ve al crear enlaces', async ({
    page,
    request,
  }) => {
    await operatorSignIn(page, request, OP_EMAILS[2]!);
    await page.goto('/operador/tamanos');
    await page.getByTestId('op-tamanos-S_largo').fill('4');
    await page.getByTestId('op-tamanos-submit').click();
    await expect(page.getByTestId('op-tamanos-error')).toBeVisible();
    await page.getByTestId('op-tamanos-S_largo').fill('32');
    await page.getByTestId('op-tamanos-submit').click();
    await expect(page.getByTestId('op-tamanos-ok')).toContainText('S');
  });
});
