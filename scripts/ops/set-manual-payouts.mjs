// Pone el calendario de pagos en MANUAL en las cuentas Express ya existentes (U5, PAYOUT_MODE=manual).
// Las cuentas nuevas se crean ya con calendario manual (StripePayoutAdapter.createAccount).
//
// Uso (solo lista, no cambia nada):
//   STRIPE_SECRET_KEY=sk_test_... node scripts/ops/set-manual-payouts.mjs
// Para aplicar el cambio hay que pasar --apply y escribir la confirmacion que pide el script:
//   STRIPE_SECRET_KEY=sk_test_... node scripts/ops/set-manual-payouts.mjs --apply
//
// Seguridad: la clave se lee del entorno (nunca como argumento), no se imprime, y con una clave
// «live» la confirmacion exige escribir el texto exacto. Solo toca cuentas de tipo express.
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key || !/^sk_(test|live)_/.test(key)) {
  process.stderr.write('Falta STRIPE_SECRET_KEY (sk_test_... o sk_live_...)\n');
  process.exit(1);
}
const live = key.startsWith('sk_live_');
const apply = process.argv.includes('--apply');
const stripe = new Stripe(key, { appInfo: { name: 'marketlink-ops' } });

const pending = [];
for await (const account of stripe.accounts.list({ limit: 100 })) {
  if (account.type !== 'express') continue;
  const interval = account.settings?.payouts?.schedule?.interval;
  if (interval === 'manual') continue;
  pending.push({ id: account.id, interval: interval ?? 'desconocido' });
}

process.stdout.write(`Modo: ${live ? 'PRODUCCION (live)' : 'pruebas (test)'}\n`);
process.stdout.write(`Cuentas Express con calendario no manual: ${pending.length}\n`);
for (const p of pending) process.stdout.write(`  ${p.id} (${p.interval})\n`);

if (!apply) {
  process.stdout.write('\nSolo listado. Usa --apply para cambiarlas a manual.\n');
  process.exit(0);
}
if (pending.length === 0) process.exit(0);

const expected = live ? `APLICAR LIVE ${pending.length}` : `APLICAR ${pending.length}`;
const rl = createInterface({ input, output });
const answer = await rl.question(`\nEscribe «${expected}» para continuar: `);
rl.close();
if (answer.trim() !== expected) {
  process.stdout.write('Confirmacion distinta: no se ha cambiado nada.\n');
  process.exit(2);
}

let changed = 0;
for (const p of pending) {
  await stripe.accounts.update(p.id, {
    settings: { payouts: { schedule: { interval: 'manual' } } },
  });
  changed += 1;
  process.stdout.write(`  ${p.id} -> manual\n`);
}
process.stdout.write(`Hecho: ${changed} cuentas.\n`);
