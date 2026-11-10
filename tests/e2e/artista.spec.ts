import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * E2E de U2 (modo E2E_ENABLED: dobles de Supabase y Stripe en proceso, Postgres real).
 * Cada prueba usa correos distintos para no depender de las demas.
 */
const SECRET = process.env.INTERNAL_JOBS_SECRET ?? '';
let counter = 0;
const uniqueEmail = (name: string) => `${name}-${Date.now()}-${counter++}@example.com`;

const photo = (width = 2400, height = 1600) =>
  sharp({ create: { width, height, channels: 3, background: { r: 190, g: 70, b: 50 } } })
    .jpeg({ quality: 90 })
    .toBuffer();

async function magicLink(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post('/api/test/sign-in-link', {
    headers: { 'x-internal-secret': SECRET },
    data: { email },
  });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { url: string }).url;
}

async function signIn(page: Page, request: APIRequestContext, email: string): Promise<void> {
  await page.goto(await magicLink(request, email));
  // El enlace no se consume al abrirlo: hace falta pulsar «Entrar» (BR2-AC4).
  await page.getByTestId('confirmar-entrar-button').click();
  await expect(page).toHaveURL(/\/artista$/);
}

async function completeSetup(page: Page): Promise<void> {
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
  await expect(page).toHaveURL(/\/artista\/cobros/);
  await expect(page.getByTestId('cobros-estado-text')).toHaveText('Cobros activos');
}

async function createListing(page: Page, title = 'Óleo sobre lienzo'): Promise<string> {
  await page.goto('/artista/enlaces/nuevo');
  await page
    .getByTestId('fotos-input')
    .setInputFiles({ name: 'obra.jpg', mimeType: 'image/jpeg', buffer: await photo() });
  await expect(page.getByTestId('fotos-item-1')).toContainText('Lista');
  await page.getByTestId('enlace-titulo-input').fill(title);
  await page.getByTestId('enlace-descripcion-input').fill('Una obra de prueba');
  await page.getByTestId('enlace-precio-input').fill('250');
  await page.getByTestId('enlace-tamano-radio-m').check();
  await page.getByTestId('enlace-modalidad-radio-punto').check();
  await page.getByTestId('enlace-guardar-button').click();
  await expect(page.getByTestId('detalle-creado')).toBeVisible();
  return page.url().split('/artista/enlaces/')[1]?.split('?')[0] ?? '';
}

test.describe('Acceso (US-001)', () => {
  test('sin sesion, el area del artista lleva a la entrada', async ({ page }) => {
    await page.goto('/artista');
    await expect(page).toHaveURL(/\/acceso\?caducada=1/);
    await expect(page.getByTestId('acceso-sesion-caducada')).toBeVisible();
  });

  test('pedir el enlace da siempre la misma respuesta, exista o no la cuenta', async ({ page }) => {
    for (const email of [uniqueEmail('nueva'), 'otra@example.com']) {
      await page.goto('/acceso');
      await page.getByTestId('acceso-email-input').fill(email);
      await page.getByTestId('acceso-submit-button').click();
      await expect(page).toHaveURL(/\/acceso\/enviado/);
      await expect(page.getByTestId('enviado-texto')).toContainText('Si el correo es válido');
    }
  });

  test('un email mal formado se corrige en el propio formulario', async ({ page }) => {
    await page.goto('/acceso');
    await page.getByTestId('acceso-email-input').fill('no-es-un-email');
    await page.getByTestId('acceso-submit-button').click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page).toHaveURL(/\/acceso$/);
  });

  test('un enlace usado no vale dos veces y el mensaje es generico', async ({
    page,
    request,
    context,
  }) => {
    const url = await magicLink(request, uniqueEmail('uso'));
    await page.goto(url);
    await page.getByTestId('confirmar-entrar-button').click();
    await expect(page).toHaveURL(/\/artista$/);
    await context.clearCookies();

    await page.goto(url);
    await page.getByTestId('confirmar-entrar-button').click();
    await expect(page.getByTestId('confirmar-error')).toContainText('Este enlace ya no es válido');
    await expect(page.getByTestId('confirmar-pedir-otro-link')).toBeVisible();
  });

  test('abrir el enlace no lo consume: solo el boton (proteccion frente a escaneres de correo)', async ({
    page,
    request,
  }) => {
    const url = await magicLink(request, uniqueEmail('escaner'));
    await page.goto(url);
    await page.goto(url); // una segunda visita (p. ej. un escaner) no lo gasta
    await page.getByTestId('confirmar-entrar-button').click();
    await expect(page).toHaveURL(/\/artista$/);
  });

  test('las cookies de sesion son HttpOnly y SameSite=Lax; cerrar sesion las borra', async ({
    page,
    request,
    context,
  }) => {
    await signIn(page, request, uniqueEmail('cookies'));
    const cookies = await context.cookies();
    const names = ['ml_at', 'ml_rt', 'ml_act'];
    for (const name of names) {
      const c = cookies.find((x) => x.name === name);
      expect(c, name).toBeDefined();
      expect(c?.httpOnly).toBe(true);
      expect(c?.sameSite).toBe('Lax');
    }
    await page.getByTestId('nav-salir').click();
    await expect(page).toHaveURL(/\/acceso/);
    expect((await context.cookies()).filter((c) => names.includes(c.name))).toHaveLength(0);
    await page.goto('/artista');
    await expect(page).toHaveURL(/\/acceso\?caducada=1/);
  });

  test('una cookie de actividad manipulada no da acceso', async ({ page, request, context }) => {
    await signIn(page, request, uniqueEmail('manipulada'));
    const cookies = await context.cookies();
    const act = cookies.find((c) => c.name === 'ml_act');
    await context.addCookies([{ ...act!, value: `${act!.value.split('.')[0]}.firmafalsa` }]);
    await page.goto('/artista');
    await expect(page).toHaveURL(/\/acceso\?caducada=1/);
  });
});

test.describe('Flujo del artista (US-002 a US-013)', () => {
  test('perfil, direccion, cobros y un enlace con foto, DM, pausar y reanudar', async ({
    page,
    request,
  }) => {
    await signIn(page, request, uniqueEmail('flujo'));
    await completeSetup(page);

    const id = await createListing(page);
    await expect(page.getByTestId('detalle-title')).toHaveText('Óleo sobre lienzo');
    await expect(page.getByTestId('enlace-estado-badge')).toContainText('Activo');
    const dm = await page.getByTestId('dm-texto-textarea').inputValue();
    const lines = dm.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Óleo sobre lienzo — 250,00\s€$/);
    expect(lines[2]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-z2-9]{8}$/);

    // La foto se guardo reducida: la miniatura mide como mucho 480 px.
    const size = await page
      .locator('[data-testid="detalle-fotos"] img')
      .evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight]);
    expect(Math.max(...size)).toBe(480);

    await page.getByTestId('enlace-pausar-button').click();
    await expect(page.getByTestId('enlace-estado-badge')).toContainText('Pausado');
    await page.getByTestId('enlace-reanudar-button').click();
    await expect(page.getByTestId('enlace-estado-badge')).toContainText('Activo');

    await page.goto('/artista/enlaces');
    await expect(page.getByTestId(`enlace-card-${id}`)).toBeVisible();
    await page.goto('/artista');
    await expect(page.getByTestId('panel-paso-enlace')).toContainText('hecho');
  });

  test('las validaciones se muestran por campo sin perder lo escrito', async ({
    page,
    request,
  }) => {
    await signIn(page, request, uniqueEmail('valida'));
    await page.goto('/artista/perfil');
    await page.getByTestId('perfil-nombre-input').fill('A');
    await page.getByTestId('perfil-instagram-input').fill('no valido!');
    await page.getByTestId('perfil-telefono-input').fill('123');
    await page.getByTestId('perfil-guardar-button').click();
    await expect(page.getByText('Escribe tu nombre artístico')).toBeVisible();
    await expect(page.getByText('Usa solo letras')).toBeVisible();
    await expect(page.getByText('teléfono español')).toBeVisible();
    await expect(page.getByTestId('perfil-nombre-input')).toHaveValue('A');

    await page.goto('/artista/direccion');
    await page.getByTestId('direccion-cp-input').fill('35001');
    await page.getByTestId('direccion-guardar-button').click();
    await expect(page.getByText('no enviamos desde islas')).toBeVisible();
  });

  test('sin cobros activos no se puede crear un enlace y se explica por que', async ({
    page,
    request,
  }) => {
    await signIn(page, request, uniqueEmail('sincobros'));
    await page.goto('/artista/enlaces/nuevo');
    await expect(page.getByTestId('nuevo-bloqueado')).toBeVisible();
    await page.goto('/artista/enlaces');
    await expect(page.getByTestId('enlaces-vacio')).toContainText('termina los pasos');
  });

  test('la foto que no es una imagen se rechaza con un mensaje claro', async ({
    page,
    request,
  }) => {
    await signIn(page, request, uniqueEmail('pdf'));
    await completeSetup(page);
    await page.goto('/artista/enlaces/nuevo');
    await page.getByTestId('fotos-input').setInputFiles({
      name: 'obra.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('%PDF-1.7 no soy una imagen'),
    });
    await expect(page.getByTestId('fotos-item-1')).toContainText('No es una foto válida');
  });

  test('cobros restringidos: los enlaces se pausan solos y no se reanudan hasta que el artista lo decide', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('restringido');
    await signIn(page, request, email);
    await completeSetup(page);
    const id = await createListing(page);

    const event = (disabled: boolean) =>
      request.post('/api/test/payout-event', {
        headers: { 'x-internal-secret': SECRET },
        data: { email, disabled },
      });
    expect((await event(true)).status()).toBe(200);

    await page.goto('/artista');
    await expect(page.getByTestId('panel-cobros-restringidos')).toBeVisible();
    await page.goto(`/artista/enlaces/${id}`);
    await expect(page.getByTestId('enlace-estado-badge')).toContainText('Pausado');
    await expect(page.getByTestId('enlace-estado-badge')).toContainText(
      'cobros están restringidos',
    );

    // Al recuperarse la cuenta, el enlace sigue pausado hasta que el artista lo reanude.
    expect((await event(false)).status()).toBe(200);
    await page.goto(`/artista/enlaces/${id}`);
    await expect(page.getByTestId('enlace-estado-badge')).toContainText('Pausado');
    await page.getByTestId('enlace-reanudar-button').click();
    await expect(page.getByTestId('enlace-estado-badge')).toContainText('Activo');
  });
});

test.describe('Activacion de cobros que tarda (Stripe real tarda unos segundos)', () => {
  test('la pantalla de cobros se actualiza sola al activarse la cuenta, sin recargar', async ({
    page,
    request,
  }) => {
    await signIn(page, request, uniqueEmail('lento'));
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
    await expect(page).toHaveURL(/\/artista\/cobros/);

    // Al volver, Stripe aun no ha terminado: se explica y hay un boton para comprobar a mano.
    await expect(page.getByTestId('cobros-estado-text')).toHaveText('Activación en curso');
    await expect(page.getByTestId('cobros-comprobar-button')).toBeVisible();
    await expect(page.getByTestId('cobros-comprobando')).toContainText('se actualiza sola');

    // Sin recargar ni pulsar nada, pasa a «Cobros activos» cuando Stripe termina.
    await expect(page.getByTestId('cobros-estado-text')).toHaveText('Cobros activos', {
      timeout: 25_000,
    });
    await expect(page.getByTestId('cobros-comprobar-button')).toHaveCount(0);
  });
});

test.describe('Aislamiento entre artistas (EN-03)', () => {
  test('un artista no ve ni abre los enlaces de otro', async ({ browser, request }) => {
    const ctxA = await browser.newContext();
    const a = await ctxA.newPage();
    await signIn(a, request, uniqueEmail('ana'));
    await completeSetup(a);
    const id = await createListing(a, 'Obra privada de Ana');

    const ctxB = await browser.newContext();
    const b = await ctxB.newPage();
    await signIn(b, request, uniqueEmail('berta'));

    await b.goto('/artista/enlaces');
    await expect(b.getByText('Obra privada de Ana')).toHaveCount(0);
    const res = await b.goto(`/artista/enlaces/${id}`);
    expect(res?.status()).toBe(404);
    await expect(b.getByText('Obra privada de Ana')).toHaveCount(0);

    // El artista A sigue viendo lo suyo.
    await a.goto(`/artista/enlaces/${id}`);
    await expect(a.getByTestId('detalle-title')).toHaveText('Obra privada de Ana');
    await ctxA.close();
    await ctxB.close();
  });

  test('las cabeceras internas enviadas por un cliente no suplantan a otro artista', async ({
    page,
    request,
  }) => {
    await signIn(page, request, uniqueEmail('suplanta'));
    const res = await page.request.get('/artista', {
      headers: { 'x-ml-artist-id': '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.status()).toBe(200);
    await page.goto('/artista/enlaces');
    await expect(page.getByTestId('enlaces-title')).toBeVisible();
  });

  test('la subida de fotos exige sesion', async ({ request }) => {
    const res = await request.post('/api/artista/fotos', {
      data: Buffer.from([0xff, 0xd8, 0xff]),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe('Webhook de cuentas', () => {
  test('rechaza firmas invalidas con 400 generico', async ({ request }) => {
    const res = await request.post('/api/webhooks/stripe-connect', {
      headers: { 'stripe-signature': 't=1,v1=falsa', 'content-type': 'application/json' },
      data: '{"id":"evt_1"}',
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('evt_1');
  });
});

test.describe('Accesibilidad y CSP (U2-NFR-US3)', () => {
  const axe = (page: Page) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();

  test('las pantallas de acceso no tienen fallos axe ni violaciones de CSP', async ({
    page,
    request,
  }) => {
    const csp: string[] = [];
    page.on('console', (m) => {
      if (/content security policy/i.test(m.text())) csp.push(m.text());
    });
    await page.goto('/acceso');
    expect((await axe(page)).violations).toEqual([]);
    await page.goto('/acceso/enviado');
    expect((await axe(page)).violations).toEqual([]);
    await page.goto(await magicLink(request, uniqueEmail('axe-acceso')));
    expect((await axe(page)).violations).toEqual([]);
    expect(csp).toEqual([]);
  });

  test('las pantallas del artista no tienen fallos axe ni violaciones de CSP', async ({
    page,
    request,
  }) => {
    const csp: string[] = [];
    page.on('console', (m) => {
      if (/content security policy/i.test(m.text())) csp.push(m.text());
    });
    await signIn(page, request, uniqueEmail('axe'));
    await completeSetup(page);
    const id = await createListing(page);

    for (const path of [
      '/artista',
      '/artista/perfil',
      '/artista/direccion',
      '/artista/cobros',
      '/artista/enlaces',
      '/artista/enlaces/nuevo',
      `/artista/enlaces/${id}`,
    ]) {
      await page.goto(path);
      const results = await axe(page);
      expect(results.violations, path).toEqual([]);
    }
    expect(csp).toEqual([]);
  });
});
