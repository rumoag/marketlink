import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, redact, assertTestKey, toForm, parseArgs } from './lib.mjs';

test('parseEnv ignora comentarios y vacios, y quita comillas', () => {
  const env = parseEnv('# comentario\n\nA=1\nB="dos"\nC=\'tres\'\nD=\nSIN_IGUAL\n');
  assert.deepEqual(env, { A: '1', B: 'dos', C: 'tres', D: '' });
});

test('assertTestKey rechaza claves reales y desconocidas, acepta de prueba', () => {
  assert.throws(() => assertTestKey('sk_live_abc123'), /modo real/);
  assert.throws(() => assertTestKey('rk_live_abc123'), /modo real/);
  assert.throws(() => assertTestKey('abc'), /clave de prueba/);
  assert.doesNotThrow(() => assertTestKey('sk_test_abc123'));
  assert.doesNotThrow(() => assertTestKey('rk_test_abc123'));
});

test('redact elimina secretos conocidos y campos sensibles o personales', () => {
  const secret = 'SUPER-SECRETA-123';
  const input = {
    Authorization: `Bearer ${secret}`,
    nota: `contiene ${secret} dentro`,
    email: 'a@b.com',
    nested: { phone: '600000000', street1: 'Calle 1', name: 'Servicio X', price: 4.5 },
    lista: [{ api_key: 'k' }, 'texto'],
  };
  const out = redact(input, [secret]);
  assert.equal(out.Authorization, '[REDACTED]');
  assert.equal(out.nota, 'contiene [REDACTED] dentro');
  assert.equal(out.email, '[REDACTED]');
  assert.equal(out.nested.phone, '[REDACTED]');
  assert.equal(out.nested.street1, '[REDACTED]');
  assert.equal(out.nested.name, 'Servicio X');
  assert.equal(out.nested.price, 4.5);
  assert.equal(out.lista[0].api_key, '[REDACTED]');
  assert.equal(out.lista[1], 'texto');
  assert.ok(!JSON.stringify(out).includes(secret));
});

test('redact no cambia los datos originales', () => {
  const input = { token: 'abcdef123456' };
  redact(input, []);
  assert.equal(input.token, 'abcdef123456');
});

test('toForm aplana objetos y listas al formato de Stripe', () => {
  const p = toForm({
    mode: 'payment',
    payment_method_types: ['card', 'bizum'],
    line_items: [{ quantity: 1, price_data: { currency: 'eur' } }],
    omitido: undefined,
    nulo: null,
  });
  const s = p.toString();
  assert.equal(p.get('mode'), 'payment');
  assert.equal(p.get('payment_method_types[0]'), 'card');
  assert.equal(p.get('payment_method_types[1]'), 'bizum');
  assert.equal(p.get('line_items[0][price_data][currency]'), 'eur');
  assert.equal(p.get('line_items[0][quantity]'), '1');
  assert.ok(!s.includes('omitido') && !s.includes('nulo'));
});

test('parseArgs separa banderas y valores', () => {
  const { flags, values } = parseArgs(['--quote', '--type=CUSTOM', 'suelto', '--confirm']);
  assert.ok(flags.has('quote') && flags.has('confirm'));
  assert.equal(values.type, 'CUSTOM');
  assert.equal(flags.has('suelto'), false);
});
