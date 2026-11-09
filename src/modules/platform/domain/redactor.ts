/**
 * Redaccion de datos para logs (BR-G2, BR-G3). Pura: no hace E/S y no muta el original.
 * Es idempotente: redact(redact(x)) = redact(x), y conserva la forma estructural del dato.
 */
export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /authorization|api[-_]?key|secret|token|password|passwd|signature|cookie|credential|salt|access[-_]?token|refresh|provider[-_]?account|stripe[-_]?account|service[-_]?role/i;
const PII_KEY =
  /e-?mail|phone|telephone|street|address|vat|iban|tax[-_]?id|surname|first[-_]?name|last[-_]?name/i;

const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const IBAN_IN_TEXT = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const LONG_TOKEN_IN_TEXT = /\b[A-Za-z0-9_-]{32,}\b/g;

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_DEPTH = 12;
const MAX_TEXT_PASSES = 5;

export const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEY.test(key) || PII_KEY.test(key);

/** Enmascara emails, IBAN y tokens largos dentro de un texto. Se repite hasta estabilizarse. */
export const maskText = (text: string): string => {
  let current = text;
  for (let i = 0; i < MAX_TEXT_PASSES; i++) {
    const next = current
      .replace(EMAIL_IN_TEXT, REDACTED)
      .replace(IBAN_IN_TEXT, REDACTED)
      // Los UUID (correlationId, ids de trabajo) no son secretos y deben seguir siendo legibles.
      .replace(LONG_TOKEN_IN_TEXT, (match) => (UUID_ONLY.test(match) ? match : REDACTED));
    if (next === current) return next;
    current = next;
  }
  return current;
};

const redactValue = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
  if (typeof value === 'string') return maskText(value);
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return '[Unserializable]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) {
    return { name: maskText(value.name), message: maskText(value.message) };
  }

  const obj = value as object;
  if (seen.has(obj)) return '[Circular]';
  seen.add(obj);

  if (Array.isArray(value)) {
    const out = value.map((item) => redactValue(item, depth + 1, seen));
    seen.delete(obj);
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    // defineProperty (y no asignacion): una clave `__proto__` propia, tipica de JSON hostil, debe
    // conservarse como dato y nunca alterar el prototipo del resultado.
    Object.defineProperty(out, key, {
      value: isSensitiveKey(key) ? REDACTED : redactValue(inner, depth + 1, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  seen.delete(obj);
  return out;
};

export const redact = (value: unknown): unknown => redactValue(value, 0, new WeakSet<object>());
