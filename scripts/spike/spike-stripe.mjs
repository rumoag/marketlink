// Spike U0 - Stripe (solo modo test). Resuelve las preguntas P5 a P7 del plan.
// Uso: node scripts/spike/spike-stripe.mjs --preflight | --bizum | --account [--new] | --charge
//      | --transfer | --balance | --payout-schedule | --payout
import {
  loadEnv,
  requireEnv,
  assertTestKey,
  request,
  toForm,
  saveResult,
  loadResult,
  parseArgs,
  runMain,
} from './lib.mjs';

const BASE = 'https://api.stripe.com/v1/';
const STATE = 'stripe-state';

loadEnv();
const { flags } = parseArgs(process.argv.slice(2));

let key = '';
const secrets = () => [key];

function call(method, path, { form, account, idem } = {}) {
  const version = process.env.STRIPE_API_VERSION;
  return request({
    method,
    url: BASE + path,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(version ? { 'Stripe-Version': version } : {}),
      ...(account ? { 'Stripe-Account': account } : {}),
      ...(idem ? { 'Idempotency-Key': idem } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? toForm(form).toString() : undefined,
  });
}

function describe(res) {
  if (res.ok) return `HTTP ${res.status} OK`;
  const e = res.body?.error;
  if (!e) return `HTTP ${res.status}`;
  return `HTTP ${res.status} ${e.type ?? ''} ${e.code ?? ''} ${e.param ? `(parametro ${e.param})` : ''}: ${e.message ?? ''}`.replace(
    /\s+/g,
    ' ',
  );
}

function state() {
  return loadResult(STATE) ?? {};
}
function saveState(patch) {
  const next = { ...state(), ...patch };
  saveResult(STATE, next, secrets());
  return next;
}

async function preflight() {
  const res = await call('GET', 'balance');
  if (!res.ok) throw new Error(`No se pudo leer el saldo: ${describe(res)}`);
  if (res.body?.livemode !== false)
    throw new Error('La cuenta responde en modo real (livemode=true). El spike se detiene.');
  const eur = (res.body.available ?? []).find((b) => b.currency === 'eur');
  console.log(
    `Preflight: modo test confirmado. Saldo disponible de la plataforma: ${eur ? eur.amount / 100 : 0} EUR`,
  );
}

function checkoutForm(methods, extra = {}) {
  return {
    mode: 'payment',
    payment_method_types: methods,
    success_url: 'https://example.com/ok',
    cancel_url: 'https://example.com/cancel',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: 1000,
          product_data: { name: 'Spike MarketLink' },
        },
      },
    ],
    ...extra,
  };
}

async function bizum() {
  const out = {};
  const attempts = [
    ['soloBizum_cargoEnPlataforma', checkoutForm(['bizum'])],
    ['tarjetaYBizum_cargoEnPlataforma', checkoutForm(['card', 'bizum'])],
  ];
  const acct = state().account;
  if (acct) {
    attempts.push([
      'soloBizum_destinationCharge',
      checkoutForm(['bizum'], { payment_intent_data: { transfer_data: { destination: acct } } }),
    ]);
  }
  for (const [name, form] of attempts) {
    const res = await call('POST', 'checkout/sessions', { form });
    console.log(`P5 ${name}: ${describe(res)}`);
    out[name] = {
      status: res.status,
      ok: res.ok,
      error: res.ok
        ? null
        : {
            type: res.body?.error?.type,
            code: res.body?.error?.code,
            param: res.body?.error?.param,
            message: res.body?.error?.message,
          },
      metodosDevueltos: res.ok ? res.body.payment_method_types : null,
    };
  }
  if (!acct) console.log('   (Para probar tambien un destination charge ejecuta antes --account.)');
  console.log(`   Resultado guardado en ${saveResult('stripe-bizum', out, secrets())}`);
}

async function account() {
  const s = state();
  let id = s.account;
  if (!id || flags.has('new')) {
    const res = await call('POST', 'accounts', {
      form: {
        type: 'express',
        country: 'ES',
        business_type: 'individual',
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      },
    });
    console.log(`P6 POST accounts (express): ${describe(res)}`);
    if (!res.ok)
      throw new Error(
        'No se pudo crear la cuenta Express de prueba. Comprueba que Connect esta activado en tu cuenta de Stripe.',
      );
    id = res.body.id;
    saveState({ account: id });
  } else {
    console.log(`P6 Se reutiliza la cuenta de prueba guardada (${id}). Usa --new para crear otra.`);
  }
  const link = await call('POST', 'account_links', {
    form: {
      account: id,
      type: 'account_onboarding',
      refresh_url: 'https://example.com/refresh',
      return_url: 'https://example.com/return',
    },
  });
  console.log(`   POST account_links: ${describe(link)}`);
  if (link.ok) {
    console.log(
      '   Abre este enlace en tu navegador y completa el onboarding con los datos de prueba de Stripe:',
    );
    console.log(`   ${link.body.url}`);
  }
  const acc = await call('GET', `accounts/${id}`);
  const status = acc.ok
    ? {
        charges_enabled: acc.body.charges_enabled,
        payouts_enabled: acc.body.payouts_enabled,
        transfers: acc.body.capabilities?.transfers,
        requirementsPendientes: acc.body.requirements?.currently_due?.length ?? null,
      }
    : null;
  console.log(`   Estado de la cuenta: ${status ? JSON.stringify(status) : describe(acc)}`);
  saveState({ accountStatus: status });
}

async function charge() {
  const res = await call('POST', 'payment_intents', {
    form: {
      amount: 2000,
      currency: 'eur',
      payment_method: 'pm_card_bypassPending',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    },
  });
  console.log(`P6 Cargo en la plataforma (PaymentIntent 20 EUR): ${describe(res)}`);
  if (!res.ok) throw new Error('No se pudo crear el cargo de prueba.');
  saveState({ paymentIntent: res.body.id, charge: res.body.latest_charge });
  console.log(`   Cargo ${res.body.latest_charge} creado. Estado: ${res.body.status}`);
}

async function transfer() {
  const s = state();
  if (!s.account)
    throw new Error('Falta la cuenta de prueba: ejecuta antes --account y completa el onboarding.');
  if (!s.charge) throw new Error('Falta un cargo de prueba: ejecuta antes --charge.');
  const res = await call('POST', 'transfers', {
    form: { amount: 1500, currency: 'eur', destination: s.account, source_transaction: s.charge },
    idem: `spike-transfer-${s.charge}`,
  });
  console.log(`P6 Transferencia con source_transaction (15 EUR): ${describe(res)}`);
  saveState({
    transfer: res.ok ? res.body.id : null,
    transferResult: { status: res.status, error: res.ok ? null : res.body?.error?.message },
  });
}

async function balance() {
  const s = state();
  if (!s.account) throw new Error('Falta la cuenta de prueba: ejecuta antes --account.');
  const res = await call('GET', 'balance', { account: s.account });
  console.log(`Saldo de la cuenta conectada: ${describe(res)}`);
  if (res.ok) {
    const eur = (list) => (list ?? []).find((b) => b.currency === 'eur')?.amount ?? 0;
    console.log(
      `   Disponible: ${eur(res.body.available) / 100} EUR | Pendiente: ${eur(res.body.pending) / 100} EUR`,
    );
    saveState({
      connectedBalance: { disponible: eur(res.body.available), pendiente: eur(res.body.pending) },
    });
  }
}

async function payoutSchedule() {
  const s = state();
  if (!s.account) throw new Error('Falta la cuenta de prueba: ejecuta antes --account.');
  const res = await call('POST', `accounts/${s.account}`, {
    form: { settings: { payouts: { schedule: { interval: 'manual' } } } },
  });
  console.log(`P7 Calendario de pagos en manual: ${describe(res)}`);
  saveState({
    payoutSchedule: {
      status: res.status,
      interval: res.ok ? res.body.settings?.payouts?.schedule?.interval : null,
      error: res.ok ? null : res.body?.error?.message,
    },
  });
}

async function payout() {
  const s = state();
  if (!s.account) throw new Error('Falta la cuenta de prueba: ejecuta antes --account.');
  const res = await call('POST', 'payouts', {
    form: { amount: 1000, currency: 'eur' },
    account: s.account,
    idem: `spike-payout-${s.account}-${Date.now()}`,
  });
  console.log(`P7 Pago al banco desde la cuenta conectada (10 EUR) por API: ${describe(res)}`);
  saveState({
    payoutResult: { status: res.status, error: res.ok ? null : res.body?.error?.message },
  });
}

async function main() {
  const commands = [
    'preflight',
    'bizum',
    'account',
    'charge',
    'transfer',
    'balance',
    'payout-schedule',
    'payout',
  ];
  const chosen = commands.filter((c) => flags.has(c));
  if (chosen.length !== 1) {
    console.log(
      `Uso: node scripts/spike/spike-stripe.mjs ${commands.map((c) => `--${c}`).join(' | ')}`,
    );
    process.exit(chosen.length === 0 ? 0 : 1);
  }
  key = requireEnv('STRIPE_SECRET_KEY');
  assertTestKey(key);
  const table = {
    preflight,
    bizum,
    account,
    charge,
    transfer,
    balance,
    'payout-schedule': payoutSchedule,
    payout,
  };
  if (chosen[0] !== 'preflight') await preflight();
  await table[chosen[0]]();
}

runMain(main);
