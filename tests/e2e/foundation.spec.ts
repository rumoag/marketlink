import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const JOBS_SECRET = process.env.INTERNAL_JOBS_SECRET ?? '';
const MONITOR_SECRET = process.env.MONITOR_SECRET ?? '';

test.describe('Cabeceras de seguridad (EN-01)', () => {
  test('la pagina de inicio lleva todas las cabeceras y una CSP con nonce sin unsafe-inline', async ({
    request,
  }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    const csp = h['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  test('cada peticion recibe un nonce distinto', async ({ request }) => {
    const a = (await request.get('/')).headers()['content-security-policy'];
    const b = (await request.get('/')).headers()['content-security-policy'];
    expect(a).not.toBe(b);
  });

  test('una ruta no registrada se deniega con 404 generico y tambien lleva cabeceras', async ({
    request,
  }) => {
    const res = await request.get('/ruta-que-no-existe');
    expect(res.status()).toBe(404);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(JSON.stringify(await res.json())).not.toContain('ruta-que-no-existe');
  });
});

test.describe('Salud (RESILIENCY-06)', () => {
  test('/api/health es publico, minimo y sin cache', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers()['cache-control']).toContain('no-store');
  });

  test('/api/health/deep se rechaza sin credenciales', async ({ request }) => {
    const res = await request.get('/api/health/deep');
    expect(res.status()).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/database|postgres/i);
  });

  test('/api/health/deep con el secreto informa de la base de datos', async ({ request }) => {
    test.skip(!MONITOR_SECRET, 'MONITOR_SECRET no definido');
    const res = await request.get('/api/health/deep', {
      headers: { 'x-monitor-secret': MONITOR_SECRET },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
  });
});

test.describe('Endpoint interno de trabajos (EN-10)', () => {
  test('se rechaza sin secreto o con secreto incorrecto', async ({ request }) => {
    expect((await request.post('/api/internal/jobs/run')).status()).toBe(401);
    const bad = await request.post('/api/internal/jobs/run', {
      headers: { 'x-internal-secret': 'x'.repeat(40) },
    });
    expect(bad.status()).toBe(401);
  });

  test('con el secreto procesa un lote', async ({ request }) => {
    test.skip(!JOBS_SECRET, 'INTERNAL_JOBS_SECRET no definido');
    const res = await request.post('/api/internal/jobs/run', {
      headers: { 'x-internal-secret': JOBS_SECRET },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({
      claimed: expect.any(Number),
      failed: expect.any(Number),
    });
  });
});

test.describe('Interfaz', () => {
  test('la pagina de inicio muestra el nombre del producto, esta en espanol y no tiene fallos de accesibilidad', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.getByTestId('home-title')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });

  test('el navegador no registra violaciones de CSP en la pagina de inicio', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (/content security policy/i.test(msg.text())) violations.push(msg.text());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(violations).toEqual([]);
  });
});
