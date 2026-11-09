import { randomBytes } from 'node:crypto';

/** Nonce de 128 bits por peticion (P-SEG-2). */
export const generateNonce = (): string => randomBytes(16).toString('base64');

export type CspOptions = {
  readonly nonce: string;
  /** En desarrollo React necesita 'unsafe-eval'; nunca en produccion (BR-S2). */
  readonly isDev?: boolean;
  /** Origenes adicionales para imagenes y conexiones (p. ej. el almacenamiento de Supabase). */
  readonly imgSources?: readonly string[];
  readonly connectSources?: readonly string[];
};

/** BR-S2 y BR-S3: parte de default-src 'self'; sin unsafe-inline; frame-ancestors 'none'. */
export const buildCsp = (options: CspOptions): string => {
  const { nonce, isDev = false } = options;
  const img = ["'self'", 'blob:', 'data:', ...(options.imgSources ?? [])].join(' ');
  const connect = ["'self'", ...(options.connectSources ?? [])].join(' ');
  const script = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDev ? ["'unsafe-eval'"] : []),
  ];
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src ${img}`,
    "font-src 'self'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
};

/** BR-S1: cabeceras de seguridad de toda respuesta. */
export const securityHeaders = (options: CspOptions): Record<string, string> => ({
  'Content-Security-Policy': buildCsp(options),
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
});
