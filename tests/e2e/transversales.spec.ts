import AxeBuilder from '@axe-core/playwright';
import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * E2E de U7 (modo E2E_ENABLED): accesibilidad con axe sobre una lista de rutas (anadir una
 * pantalla es anadir una linea), pantalla de salud y condiciones legales con los plazos reales.
 */
const SECRET = process.env.INTERNAL_JOBS_SECRET ?? '';
// Cada prueba que inicia sesion usa su propio operador: el paso TOTP no se acepta dos veces por
// operador (anti-repeticion) y las pruebas corren en paralelo (el 0 es de operador.spec.ts).
const OP_EMAILS = (
  process.env.OPERATOR_EMAILS ??
  'operador@example.com,operador2@example.com,operador3@example.com,operador4@example.com'
)
  .split(',')
  .map((e) => e.trim());
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

async function link(request: APIRequestContext, email: string, operator: boolean): Promise<string> {
  const res = await request.post('/api/test/sign-in-link', {
    headers: { 'x-internal-secret': SECRET },
    data: { email, operator },
  });
  return ((await res.json()) as { url: string }).url;
}

async function operatorSignIn(
  page: Page,
  request: APIRequestContext,
  email: string,
): Promise<void> {
  await page.goto(await link(request, email, true));
  await page.getByTestId('operador-confirmar-button').click();
  await page.getByTestId('operador-codigo-input').fill(totp());
  await page.getByTestId('operador-codigo-submit').click();
  await expect(page).toHaveURL(/\/operador$/);
}

async function artistSignIn(page: Page, request: APIRequestContext): Promise<void> {
  await page.goto(await link(request, uniqueEmail('artista'), false));
  await page.getByTestId('confirmar-entrar-button').click();
  await expect(page).toHaveURL(/\/artista$/);
}

/** Rutas comprobadas con axe (EN-15). Para cubrir una pantalla nueva, anade su ruta aqui. */
const PUBLIC_ROUTES = [
  '/',
  '/acceso',
  '/privacidad',
  '/condiciones',
  '/compra/cancelada',
  '/operador/acceso',
];
const ARTIST_ROUTES = [
  '/artista',
  '/artista/perfil',
  '/artista/direccion',
  '/artista/cobros',
  '/artista/enlaces',
  '/artista/pedidos',
  '/artista/dinero',
];
const OPERATOR_ROUTES = [
  '/operador',
  '/operador/pedidos',
  '/operador/borradores',
  '/operador/metricas',
  '/operador/salud',
  '/operador/tamanos',
];

const expectAccessible = async (page: Page, route: string) => {
  await page.goto(route);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, `violaciones en ${route}`).toEqual([]);
};

test.describe('Accesibilidad WCAG AA (EN-15)', () => {
  test('páginas públicas', async ({ page }) => {
    for (const route of PUBLIC_ROUTES) await expectAccessible(page, route);
  });

  test('área de la artista', async ({ page, request }) => {
    await artistSignIn(page, request);
    for (const route of ARTIST_ROUTES) await expectAccessible(page, route);
  });

  test('panel del operador', async ({ page, request }) => {
    await operatorSignIn(page, request, OP_EMAILS[1]!);
    for (const route of OPERATOR_ROUTES) await expectAccessible(page, route);
  });
});

test.describe('Salud y legales (EN-09, US-052)', () => {
  test('la pantalla de salud muestra estado, secciones y cuotas', async ({ page, request }) => {
    await operatorSignIn(page, request, OP_EMAILS[3]!);
    await page.getByTestId('op-nav-salud').click();
    await expect(page.getByTestId('op-salud-title')).toBeVisible();
    await expect(page.getByTestId('op-salud-estado')).toContainText(/Correcto|Atención|Crítico/);
    await expect(page.getByTestId('op-salud-db')).toContainText('Responde');
    await expect(page.getByTestId('op-salud-cuotas')).toContainText('Última revisión');
    await expect(page.locator('body')).not.toContainText(/secret|passphrase/i);
  });

  test('la privacidad y las condiciones muestran los plazos y el contacto reales', async ({
    page,
  }) => {
    await page.goto('/privacidad');
    await expect(page.getByTestId('legal-plazos')).toContainText('12 meses');
    await expect(page.getByTestId('legal-plazos')).toContainText('30 días');
    await expect(page.getByTestId('legal-derechos')).toContainText('@');
    await page.goto('/condiciones');
    await expect(page.getByTestId('legal-contacto')).toContainText('@');
  });

  test('sin sesión de operador la pantalla de salud no existe', async ({ page }) => {
    await page.goto('/operador/salud');
    await expect(page).toHaveURL(/\/operador\/acceso$/);
  });
});
