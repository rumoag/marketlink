// Spike U0 - Packlink PRO. Resuelve las preguntas P1 a P4 del plan.
// Uso: node scripts/spike/spike-packlink.mjs --check | --quote | --register --type=X --confirm
//      | --unregister --id=N --confirm | --draft [--modality=punto|recogida] --confirm
import { randomUUID, randomBytes } from 'node:crypto';
import { loadEnv, requireEnv, request, saveResult, parseArgs, runMain } from './lib.mjs';

const BASE = 'https://api.packlink.com/v1/';

// Tamanos predefinidos del requisito FR-05 (cm y kg)
const SIZES = {
  S: { length: 30, width: 25, height: 5, weight: 1 },
  M: { length: 50, width: 40, height: 10, weight: 2 },
  L: { length: 80, width: 60, height: 10, weight: 5 },
};

loadEnv();
const { flags, values } = parseArgs(process.argv.slice(2));

let apiKey = '';
const secrets = () => [apiKey];

function call(method, path, { query, json } = {}) {
  let url = BASE + path;
  if (query) url += '?' + new URLSearchParams(query).toString();
  return request({
    method,
    url,
    headers: {
      Authorization: apiKey,
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
  });
}

function summarizeError(res) {
  const b = res.body;
  const message =
    typeof b === 'string'
      ? b.slice(0, 300)
      : (b?.message ?? b?.error ?? JSON.stringify(b)?.slice(0, 300));
  return `HTTP ${res.status}: ${message}`;
}

function zips() {
  return {
    fromZip: process.env.SPIKE_FROM_ZIP || '28001',
    fromCity: process.env.SPIKE_FROM_CITY || 'Madrid',
    toZip: process.env.SPIKE_TO_ZIP || '08001',
    toCity: process.env.SPIKE_TO_CITY || 'Barcelona',
  };
}

function servicesList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.services)) return body.services;
  return [];
}

// El formato del precio no esta verificado: se prueban varias formas conocidas.
function priceOf(service) {
  const candidates = [service.total_price, service.price, service.base_price];
  for (const c of candidates) {
    if (typeof c === 'number') return c;
    if (c && typeof c === 'object') {
      const inner = c.total_price ?? c.base_price ?? c.price;
      if (typeof inner === 'number') return inner;
    }
  }
  return null;
}

function priceShape(service) {
  return Object.fromEntries(
    Object.entries(service)
      .filter(([k]) => /price|cost|fee/i.test(k))
      .map(([k, v]) => [
        k,
        v === null
          ? 'null'
          : typeof v === 'object'
            ? `object(${Object.keys(v).join(',')})`
            : typeof v,
      ]),
  );
}

function describeDates(service) {
  const d = service.available_dates;
  if (d === undefined || d === null) return null;
  if (Array.isArray(d)) return { tipo: 'array', ejemplo: d.slice(0, 2) };
  if (typeof d === 'object') {
    const keys = Object.keys(d).slice(0, 2);
    return { tipo: 'object', ejemplo: Object.fromEntries(keys.map((k) => [k, d[k]])) };
  }
  return { tipo: typeof d };
}

async function check() {
  const out = {};
  const clients = await call('GET', 'clients');
  out.clients = {
    status: clients.status,
    camposDevueltos:
      clients.body && typeof clients.body === 'object' ? Object.keys(clients.body) : null,
  };
  console.log(`P1 GET clients -> HTTP ${clients.status}`);
  if (!clients.ok) console.log(`   ${summarizeError(clients)}`);

  const parcels = await call('GET', 'users/parcels');
  out.parcels = {
    status: parcels.status,
    total: Array.isArray(parcels.body) ? parcels.body.length : null,
  };
  console.log(`   GET users/parcels -> HTTP ${parcels.status}`);

  const warehouses = await call('GET', 'clients/warehouses');
  out.warehouses = {
    status: warehouses.status,
    total: Array.isArray(warehouses.body) ? warehouses.body.length : null,
  };
  console.log(`   GET clients/warehouses -> HTTP ${warehouses.status}`);

  console.log(
    `   Autenticacion con "Authorization: <clave>": ${clients.ok ? 'FUNCIONA' : 'NO funciona (ver codigo)'}`,
  );
  console.log(`   Resultado guardado en ${saveResult('packlink-check', out, secrets())}`);
}

async function quoteSize(key) {
  const { fromZip, toZip } = zips();
  const p = SIZES[key];
  const res = await call('GET', 'services', {
    query: {
      'from[country]': 'ES',
      'from[zip]': fromZip,
      'to[country]': 'ES',
      'to[zip]': toZip,
      source: 'PRO',
      'packages[0][height]': String(p.height),
      'packages[0][width]': String(p.width),
      'packages[0][length]': String(p.length),
      'packages[0][weight]': String(p.weight),
    },
  });
  return { key, res, list: servicesList(res.body) };
}

function cheapest(list, dropoff) {
  const rows = list.filter((s) => Boolean(s.dropoff) === dropoff && priceOf(s) !== null);
  rows.sort((a, b) => priceOf(a) - priceOf(b));
  return rows[0] ?? null;
}

async function quote() {
  const result = {};
  for (const key of Object.keys(SIZES)) {
    const { res, list } = await quoteSize(key);
    console.log(`P2 Tamano ${key}: HTTP ${res.status}, ${list.length} servicios`);
    if (!res.ok) {
      console.log(`   ${summarizeError(res)}`);
      result[key] = { status: res.status, error: summarizeError(res) };
      continue;
    }
    const punto = cheapest(list, true);
    const recogida = cheapest(list, false);
    const fmt = (s) =>
      s ? `${s.carrier_name} / ${s.name} = ${priceOf(s)} EUR (servicio ${s.id})` : 'ninguno';
    console.log(`   Mas barato punto (dropoff=true):    ${fmt(punto)}`);
    console.log(`   Mas barato recogida (dropoff=false): ${fmt(recogida)}`);
    if (punto && recogida)
      console.log(
        `   Diferencia recogida - punto: ${(priceOf(recogida) - priceOf(punto)).toFixed(2)} EUR`,
      );
    result[key] = {
      status: res.status,
      total: list.length,
      masBaratoPunto: punto && {
        id: punto.id,
        carrier: punto.carrier_name,
        nombre: punto.name,
        precio: priceOf(punto),
      },
      masBaratoRecogida: recogida && {
        id: recogida.id,
        carrier: recogida.carrier_name,
        nombre: recogida.name,
        precio: priceOf(recogida),
      },
      formaDelPrecio: list[0] ? priceShape(list[0]) : null,
      fechasDisponibles: list[0] ? describeDates(list[0]) : null,
      servicios: list.map((s) => ({
        id: s.id,
        carrier: s.carrier_name,
        nombre: s.name,
        dropoff: s.dropoff,
        entregaEnPunto: s.delivery_to_parcelshop,
        transito: s.transit_time,
        categoria: s.category,
        precio: priceOf(s),
        camposDePrecio: priceShape(s),
      })),
    };
  }
  console.log(
    `   Resultado guardado en ${saveResult('packlink-quote', { origen: zips(), tamanos: result }, secrets())}`,
  );
}

async function register() {
  const type = values.type;
  if (!type)
    throw new Error(
      'Indica el tipo de integracion con --type=VALOR (ver README: cada intento puede ocupar tu unica conexion del plan Free).',
    );
  if (!flags.has('confirm'))
    throw new Error(
      '--register crea una integracion en tu cuenta de Packlink. Repite con --confirm si estas seguro.',
    );
  const webhookUrl = requireEnv('SPIKE_WEBHOOK_URL');
  const body = {
    integration_type: type,
    integration: { guid: randomUUID(), name: 'MarketLink Spike' },
    webhooks: {
      http_header_name: 'X-Packlink-Webhook-Secret',
      http_header_value: randomBytes(24).toString('hex'),
      status_update_url: webhookUrl,
    },
  };
  const res = await call('POST', 'integrations', { json: body });
  console.log(`P3 POST integrations (tipo "${type}") -> HTTP ${res.status}`);
  if (!res.ok) console.log(`   ${summarizeError(res)}`);
  else
    console.log(
      '   Integracion registrada. Anota el integration_id del archivo de resultados para poder borrarla con --unregister.',
    );
  console.log(
    `   Resultado guardado en ${saveResult('packlink-register', { tipo: type, status: res.status, respuesta: res.body }, [...secrets(), body.webhooks.http_header_value])}`,
  );
}

async function unregister() {
  const id = values.id;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error('Indica el identificador con --id=VALOR.');
  if (!flags.has('confirm'))
    throw new Error('--unregister borra una integracion. Repite con --confirm si estas seguro.');
  const res = await call('DELETE', `integrations/${encodeURIComponent(id)}`);
  console.log(`DELETE integrations/${id} -> HTTP ${res.status}`);
  if (!res.ok) console.log(`   ${summarizeError(res)}`);
}

function person(name, zip, city, street) {
  return {
    name,
    surname: 'Prueba',
    company: '',
    street1: street,
    street2: '',
    zip_code: zip,
    city,
    country: 'ES',
    phone: '600000000',
    email: process.env.SPIKE_EMAIL || 'spike@example.com',
  };
}

async function draft() {
  if (!flags.has('confirm')) {
    throw new Error(
      '--draft crea un borrador de envio en tu cuenta de Packlink (no lo paga). Repite con --confirm si estas seguro.',
    );
  }
  const modality = values.modality || 'punto';
  if (!['punto', 'recogida'].includes(modality))
    throw new Error('--modality debe ser punto o recogida.');
  const { fromZip, fromCity, toZip, toCity } = zips();

  const { res: qres, list } = await quoteSize('S');
  if (!qres.ok) throw new Error(`No se pudo cotizar: ${summarizeError(qres)}`);
  const service = cheapest(list, modality === 'punto');
  if (!service) throw new Error(`Sin servicios ${modality} para ${fromZip} -> ${toZip}.`);
  console.log(
    `P4 Servicio elegido: ${service.carrier_name} / ${service.name} (${service.id}) = ${priceOf(service)} EUR`,
  );

  const body = {
    service_id: service.id,
    carrier: service.carrier_name,
    content: 'Obra de arte (borrador de prueba)',
    contentvalue: 10,
    content_second_hand: false,
    shipment_custom_reference: `spike-${Date.now()}`,
    packages: [{ ...SIZES.S }],
    from: person('Remitente', fromZip, fromCity, 'Calle de Prueba 1'),
    to: person('Destinatario', toZip, toCity, 'Calle de Prueba 2'),
  };

  if (modality === 'punto') {
    const points = await call('GET', `dropoffs/${service.id}/ES/${fromZip}`);
    const pointList = Array.isArray(points.body) ? points.body : [];
    console.log(`   GET dropoffs -> HTTP ${points.status}, ${pointList.length} puntos`);
    const first = pointList[0];
    const pointId = first?.id ?? first?.code;
    if (!pointId) throw new Error('No se encontro ningun punto de entrega con identificador.');
    body.dropoff_point_id = pointId;
  } else {
    if (!values.date || !values.time) {
      throw new Error(
        'Para recogida indica --date=AAAA/MM/DD --time=FRANJA con valores de fechasDisponibles (ver packlink-quote.json).',
      );
    }
    body.collection_date = values.date;
    body.collection_time = values.time;
  }

  const res = await call('POST', 'shipments', { json: body });
  console.log(`   POST shipments -> HTTP ${res.status}`);
  if (!res.ok) console.log(`   ${summarizeError(res)}`);
  const reference = res.body?.reference;
  let estado = null;
  if (res.ok && reference) {
    const st = await call('GET', `shipments/${encodeURIComponent(reference)}`);
    estado = {
      status: st.status,
      camposDevueltos: st.body && typeof st.body === 'object' ? Object.keys(st.body) : null,
    };
    console.log(
      `   Borrador creado, referencia ${reference}. NO esta pagado: borralo desde el panel de Packlink si no lo necesitas.`,
    );
  }
  console.log(
    `   Resultado guardado en ${saveResult(`packlink-draft-${modality}`, { modality, status: res.status, referencia: reference ?? null, estado, error: res.ok ? null : res.body }, secrets())}`,
  );
}

async function main() {
  const commands = ['check', 'quote', 'register', 'unregister', 'draft'];
  const chosen = commands.filter((c) => flags.has(c));
  if (chosen.length !== 1) {
    console.log(
      'Uso: node scripts/spike/spike-packlink.mjs --check | --quote | --register --type=X --confirm | --unregister --id=N --confirm | --draft [--modality=punto|recogida] --confirm',
    );
    process.exit(chosen.length === 0 ? 0 : 1);
  }
  apiKey = requireEnv('PACKLINK_API_KEY');
  const table = { check, quote, register, unregister, draft };
  await table[chosen[0]]();
}

runMain(main);
