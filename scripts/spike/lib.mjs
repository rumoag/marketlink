// Utilidades compartidas del spike U0. Sin dependencias externas.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(here, 'out');
export const PROJECT_ROOT = join(here, '..', '..');

const SENSITIVE_KEY = /authorization|api[-_]?key|secret|token|password|passwd|signature/i;
const PII_KEY = /e-?mail|phone|telephone|street|address|vat|iban|tax|surname/i;

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function loadEnv(path = join(PROJECT_ROOT, '.env')) {
  if (!existsSync(path)) return {};
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `Falta la variable ${name}. Rellenala en marketlink/.env (copia de .env.example).`,
    );
  return value;
}

export function assertTestKey(key) {
  if (/^(sk|rk)_live_/.test(key)) {
    throw new Error(
      'Se ha detectado una clave de Stripe en modo real. El spike solo funciona con claves de prueba (sk_test_...).',
    );
  }
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error(
      'La clave de Stripe no parece una clave de prueba (debe empezar por sk_test_).',
    );
  }
}

export function redact(value, secrets = []) {
  const known = secrets.filter((s) => typeof s === 'string' && s.length >= 6);
  const walk = (v, key) => {
    if (key && (SENSITIVE_KEY.test(key) || PII_KEY.test(key)) && v !== null && v !== undefined) {
      return '[REDACTED]';
    }
    if (typeof v === 'string') {
      let s = v;
      for (const k of known) s = s.split(k).join('[REDACTED]');
      return s;
    }
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, undefined));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
  };
  return walk(value, undefined);
}

export function toForm(obj) {
  const params = new URLSearchParams();
  const add = (prefix, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => add(`${prefix}[${i}]`, x));
    } else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) add(prefix ? `${prefix}[${k}]` : k, x);
    } else {
      params.append(prefix, String(v));
    }
  };
  add('', obj);
  return params;
}

export function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.add(body);
    else values[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return { flags, values };
}

export async function request({ method = 'GET', url, headers = {}, body, timeoutMs = 15000 }) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason =
      err?.name === 'TimeoutError'
        ? `tiempo de espera agotado (${timeoutMs} ms)`
        : (err?.cause?.code ?? err?.message ?? 'error de red');
    throw new Error(`Fallo de red en ${method} ${new URL(url).pathname}: ${reason}`);
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, ok: res.ok, ms: Date.now() - started, body: parsed };
}

function assertSafeName(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Nombre de resultado no valido: ${name}`);
}

export function saveResult(name, data, secrets = []) {
  assertSafeName(name);
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${name}.json`);
  writeFileSync(file, JSON.stringify(redact(data, secrets), null, 2) + '\n', 'utf8');
  return file;
}

export function loadResult(name) {
  assertSafeName(name);
  const file = join(OUT_DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function runMain(main) {
  main().catch((err) => {
    console.error(`Error: ${err?.message ?? 'fallo desconocido'}`);
    process.exit(1);
  });
}
