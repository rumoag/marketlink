import { z } from 'zod';
import { err, ok, type Result } from '@/modules/kernel/domain/result';

/**
 * Configuracion (BR-K1 a BR-K6). Se carga una vez al arrancar, se congela y nunca imprime
 * valores secretos: los errores solo nombran la variable.
 */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  /** Unico acceso al valor; usar solo donde se necesita (p. ej. al conectar). */
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return '[REDACTED]';
  }
  toString(): string {
    return '[REDACTED]';
  }
}

export type Environment = 'sandbox' | 'live';

export type AppConfig = {
  readonly environment: Environment;
  readonly appName: string;
  readonly appUrl: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly flags: { readonly paymentManualEnabled: boolean; readonly bizumEnabled: boolean };
  readonly maxListingPriceCents: number;
  readonly databaseUrl: Secret;
  /** Certificado de la CA de la base (PEM) para verificar el TLS; obligatorio en live. */
  readonly databaseCaCert: string | undefined;
  readonly internalJobsSecret: Secret;
  readonly rateLimitSalt: Secret;
  readonly monitorSecret: Secret | undefined;
  /** Secreto con el que se firma la cookie de actividad de la sesion. */
  readonly sessionCookieSecret: Secret;
  /** Solo pruebas: sustituye a los proveedores externos por dobles. Nunca en live. */
  readonly e2eEnabled: boolean;
  readonly supabase:
    | {
        readonly url: string;
        readonly publishableKey: string;
        readonly serviceRoleKey: Secret;
      }
    | undefined;
  readonly stripe:
    | {
        readonly secretKey: Secret;
        readonly apiVersion: string;
        readonly connectWebhookSecret: Secret;
        /** U3: secreto del webhook de la plataforma (Checkout y reembolsos). */
        readonly platformWebhookSecret: Secret;
      }
    | undefined;
  /** U3/U4: clave de la API de Packlink y secreto de su webhook. */
  readonly packlink:
    { readonly apiKey: Secret; readonly webhookSecret: Secret | undefined } | undefined;
  /** U4: correo transaccional (Resend). */
  readonly email:
    | {
        readonly apiKey: Secret;
        readonly from: string;
        readonly operator: string;
        /** Fuera de `live`, todos los correos van a esta direccion (asunto `[PRUEBA]`). */
        readonly sandboxRedirect: string | undefined;
      }
    | undefined;
  /** U3: secreto del que se deriva el token de seguimiento (y el anterior, durante una rotacion). */
  readonly tracking: { readonly secret: Secret; readonly previousSecret: Secret | undefined };
  /** U3: duraciones de la compra (minutos). */
  readonly checkout: { readonly sessionMinutes: number; readonly reservationMinutes: number };
  /** U8: cache de Packlink y umbral de borradores sin pagar. */
  readonly shippingOptions: {
    readonly quoteCacheTtlMinutes: number;
    readonly unpaidDraftAlertHours: number;
  };
  /** U3: plazos de retencion de datos personales y contables. */
  readonly retention: {
    readonly unpaidDays: number;
    readonly personalMonths: number;
    readonly financialYears: number;
    readonly labelDays: number;
    readonly labelUndeliveredDays: number;
    readonly notificationMonths: number;
  };
  /** U7: direccion publica de contacto (privacidad, condiciones, pie del pago). */
  readonly contactEmail: string;
  /** U7: umbrales de las alertas de seguridad por hora. */
  readonly alerts: {
    readonly authFailures: number;
    readonly authzDenied: number;
    readonly webhookSignatures: number;
  };
  /** U6: acceso del operador. `undefined` si no esta configurado (solo fuera de live). */
  readonly operator:
    | {
        readonly emails: readonly string[];
        /** Secreto TOTP en Base32 por email (en minusculas). */
        readonly totpSecrets: ReadonlyMap<string, Secret>;
        readonly sessionSecret: Secret;
      }
    | undefined;
  /** U5: dinero. */
  readonly money: {
    readonly payoutMode: 'manual' | 'automatico';
    readonly settlementDelayHours: number;
    readonly staleDeliveryDays: number;
    readonly blockedAlertDays: number;
    readonly recentLoginMinutes: number;
  };
};

const BASE32 = /^[A-Z2-7]{16,128}$/;

type OperatorEnv = {
  OPERATOR_EMAILS?: string | undefined;
  OPERATOR_TOTP_SECRETS?: string | undefined;
  OPERATOR_SESSION_SECRET?: string | undefined;
};

/** Valida la lista de operadores y sus secretos TOTP; solo nombres de variable en los errores. */
const parseOperator = (e: OperatorEnv, problems: string[]): AppConfig['operator'] => {
  if (
    e.OPERATOR_EMAILS === undefined &&
    e.OPERATOR_TOTP_SECRETS === undefined &&
    e.OPERATOR_SESSION_SECRET === undefined
  ) {
    return undefined;
  }
  const email = z.string().email().max(254);
  const emails = (e.OPERATOR_EMAILS ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x !== '');
  if (emails.length === 0 || emails.some((x) => !email.safeParse(x).success)) {
    problems.push('OPERATOR_EMAILS: invalida o ausente');
  }
  const secrets = new Map<string, Secret>();
  for (const pair of (e.OPERATOR_TOTP_SECRETS ?? '').split(',')) {
    const [rawEmail, rawSecret, ...rest] = pair.trim().split(':');
    const mail = rawEmail?.trim().toLowerCase() ?? '';
    const secret = rawSecret?.trim().toUpperCase() ?? '';
    if (pair.trim() === '') continue;
    if (rest.length > 0 || !email.safeParse(mail).success || !BASE32.test(secret)) {
      problems.push('OPERATOR_TOTP_SECRETS: invalida o ausente');
      break;
    }
    secrets.set(mail, new Secret(secret));
  }
  if (emails.some((x) => !secrets.has(x)) && !problems.some((p) => p.startsWith('OPERATOR_TOTP'))) {
    problems.push('OPERATOR_TOTP_SECRETS: falta el secreto de algun operador');
  }
  if (e.OPERATOR_SESSION_SECRET === undefined) {
    problems.push('OPERATOR_SESSION_SECRET: invalida o ausente');
  }
  if (problems.some((p) => p.startsWith('OPERATOR_')) || e.OPERATOR_SESSION_SECRET === undefined) {
    return undefined;
  }
  return {
    emails,
    totpSecrets: secrets,
    sessionSecret: new Secret(e.OPERATOR_SESSION_SECRET),
  };
};

export type ConfigError = { readonly issues: readonly string[] };

const bool = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

const schema = z.object({
  APP_ENV: z.enum(['sandbox', 'live']),
  PRODUCT_NAME: z.string().trim().min(1).max(60).optional(),
  APP_URL: z.string().url().max(200).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  PAYMENT_MANUAL_ENABLED: bool,
  BIZUM_ENABLED: bool,
  MAX_LISTING_PRICE_CENTS: z.coerce.number().int().min(100).max(100_000).optional(),
  // Una cadena mal formada (comillas, sin esquema...) la interpreta pg con un servidor falso.
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/[^\s"']+$/),
  DATABASE_CA_CERT: z.string().min(50).optional(),
  INTERNAL_JOBS_SECRET: z.string().min(32),
  RATE_LIMIT_SALT: z.string().min(32),
  MONITOR_SECRET: z.string().min(32).optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_API_VERSION: z.string().min(1).max(40).optional(),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().min(10).optional(),
  STRIPE_PLATFORM_WEBHOOK_SECRET: z.string().min(10).optional(),
  PACKLINK_API_KEY: z.string().min(8).optional(),
  PACKLINK_WEBHOOK_SECRET: z.string().min(16).optional(),
  RESEND_API_KEY: z.string().min(8).optional(),
  EMAIL_FROM: z.string().email().max(254).optional(),
  OPERATOR_EMAIL: z.string().email().max(254).optional(),
  EMAIL_SANDBOX_REDIRECT: z.string().email().max(254).optional(),
  CONTACT_EMAIL: z.string().email().max(254).optional(),
  ALERT_AUTH_FAILURES: z.coerce.number().int().min(1).max(1000).optional(),
  ALERT_AUTHZ_DENIED: z.coerce.number().int().min(1).max(1000).optional(),
  ALERT_WEBHOOK_SIGNATURES: z.coerce.number().int().min(1).max(1000).optional(),
  OPERATOR_EMAILS: z.string().min(3).max(1000).optional(),
  OPERATOR_TOTP_SECRETS: z.string().min(10).max(2000).optional(),
  OPERATOR_SESSION_SECRET: z.string().min(32).optional(),
  PAYOUT_MODE: z.enum(['manual', 'automatico']).optional(),
  SETTLEMENT_DELAY_HOURS: z.coerce.number().int().min(0).max(720).optional(),
  STALE_DELIVERY_DAYS: z.coerce.number().int().min(1).max(60).optional(),
  SETTLEMENT_BLOCKED_ALERT_DAYS: z.coerce.number().int().min(1).max(60).optional(),
  RECENT_LOGIN_MINUTES: z.coerce.number().int().min(1).max(120).optional(),
  RETENTION_LABEL_DAYS: z.coerce.number().int().min(1).max(365).optional(),
  RETENTION_LABEL_UNDELIVERED_DAYS: z.coerce.number().int().min(1).max(730).optional(),
  RETENTION_NOTIFICATION_MONTHS: z.coerce.number().int().min(1).max(60).optional(),
  TRACKING_TOKEN_SECRET: z.string().min(32),
  TRACKING_TOKEN_SECRET_PREVIOUS: z.string().min(32).optional(),
  CHECKOUT_SESSION_MINUTES: z.coerce.number().int().min(30).max(120).optional(),
  RESERVATION_MINUTES: z.coerce.number().int().min(30).max(180).optional(),
  QUOTE_CACHE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).optional(),
  UNPAID_DRAFT_ALERT_HOURS: z.coerce.number().int().min(1).max(720).optional(),
  RETENTION_UNPAID_DAYS: z.coerce.number().int().min(1).max(365).optional(),
  RETENTION_PERSONAL_MONTHS: z.coerce.number().int().min(1).max(120).optional(),
  RETENTION_FINANCIAL_YEARS: z.coerce.number().int().min(1).max(20).optional(),
  SESSION_COOKIE_SECRET: z.string().min(32),
  E2E_ENABLED: bool,
  SUPABASE_URL: z.string().url().max(200).optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(10).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10).optional(),
});

const STRIPE_TEST = /^(sk|rk)_test_/;
const STRIPE_LIVE = /^(sk|rk)_live_/;

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !(value instanceof Secret)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

/** Valida el entorno y construye la configuracion. No lee `process.env` por si misma. */
export const loadConfig = (
  env: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigError> => {
  // Los valores vacios se tratan como ausentes: un .env con claves en blanco no engana.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    // Solo nombres de variable: nunca el valor recibido (BR-K6).
    const issues = [
      ...new Set(parsed.error.issues.map((i) => `${String(i.path[0])}: invalida o ausente`)),
    ];
    return err({ issues });
  }
  const e = parsed.data;

  const problems: string[] = [];
  const stripe = e.STRIPE_SECRET_KEY;
  if (stripe !== undefined) {
    // BR-K3: el entorno y el tipo de clave deben coincidir.
    if (e.APP_ENV === 'live' && !STRIPE_LIVE.test(stripe)) {
      problems.push('STRIPE_SECRET_KEY: no coincide con APP_ENV=live');
    }
    if (e.APP_ENV === 'sandbox' && !STRIPE_TEST.test(stripe)) {
      problems.push('STRIPE_SECRET_KEY: no coincide con APP_ENV=sandbox');
    }
  }
  if (e.APP_ENV === 'live' && e.APP_URL !== undefined && !e.APP_URL.startsWith('https://')) {
    problems.push('APP_URL: debe ser https en live');
  }
  // SECURITY-09: el modo de pruebas nunca puede activarse en live.
  if (e.E2E_ENABLED && e.APP_ENV === 'live') {
    problems.push('E2E_ENABLED: no permitido con APP_ENV=live');
  }
  // Sin dobles de prueba, los proveedores externos son obligatorios (solo nombres, BR-K6).
  if (!e.E2E_ENABLED) {
    const required = {
      SUPABASE_URL: e.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: e.SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_SERVICE_ROLE_KEY: e.SUPABASE_SERVICE_ROLE_KEY,
      STRIPE_SECRET_KEY: e.STRIPE_SECRET_KEY,
      STRIPE_API_VERSION: e.STRIPE_API_VERSION,
      STRIPE_CONNECT_WEBHOOK_SECRET: e.STRIPE_CONNECT_WEBHOOK_SECRET,
      STRIPE_PLATFORM_WEBHOOK_SECRET: e.STRIPE_PLATFORM_WEBHOOK_SECRET,
      PACKLINK_API_KEY: e.PACKLINK_API_KEY,
      PACKLINK_WEBHOOK_SECRET: e.PACKLINK_WEBHOOK_SECRET,
      RESEND_API_KEY: e.RESEND_API_KEY,
      EMAIL_FROM: e.EMAIL_FROM,
      OPERATOR_EMAIL: e.OPERATOR_EMAIL,
    };
    for (const [name, value] of Object.entries(required)) {
      if (value === undefined) problems.push(`${name}: invalida o ausente`);
    }
  }
  if (
    e.APP_ENV === 'live' &&
    e.SUPABASE_URL !== undefined &&
    !e.SUPABASE_URL.startsWith('https://')
  ) {
    problems.push('SUPABASE_URL: debe ser https en live');
  }
  if (e.APP_ENV === 'live' && e.DATABASE_CA_CERT === undefined) {
    problems.push('DATABASE_CA_CERT: obligatoria en live (verifica el TLS de la base)');
  }
  // U3 (NFR-U3-24, BR3-MN5): el modo manual no puede activarse en real hasta decidir la politica
  // del importe y de quien paga el envio.
  if (e.APP_ENV === 'live' && e.PAYMENT_MANUAL_ENABLED) {
    problems.push('PAYMENT_MANUAL_ENABLED: no permitido con APP_ENV=live');
  }
  // U4 (NFR-U4, Q1 A de infraestructura): fuera de live los correos nunca van a personas reales.
  if (!e.E2E_ENABLED && e.APP_ENV === 'sandbox' && e.EMAIL_SANDBOX_REDIRECT === undefined) {
    problems.push('EMAIL_SANDBOX_REDIRECT: invalida o ausente');
  }
  // U5: en live el modo de retirada se decide a proposito (depende del spike de U0).
  if (!e.E2E_ENABLED && e.APP_ENV === 'live' && e.PAYOUT_MODE === undefined) {
    problems.push('PAYOUT_MODE: invalida o ausente');
  }
  // U7: en live hay que publicar una direccion de contacto real para peticiones de privacidad.
  if (!e.E2E_ENABLED && e.APP_ENV === 'live' && e.CONTACT_EMAIL === undefined) {
    problems.push('CONTACT_EMAIL: invalida o ausente');
  }
  // U6: el panel del operador. En live es obligatorio y cada email lleva su secreto TOTP.
  const operator = parseOperator(e, problems);
  if (!e.E2E_ENABLED && e.APP_ENV === 'live' && operator === undefined) {
    for (const name of ['OPERATOR_EMAILS', 'OPERATOR_TOTP_SECRETS', 'OPERATOR_SESSION_SECRET']) {
      if (!problems.some((p) => p.startsWith(name))) problems.push(`${name}: invalida o ausente`);
    }
  }
  if (e.CHECKOUT_SESSION_MINUTES !== undefined && e.RESERVATION_MINUTES !== undefined) {
    if (e.RESERVATION_MINUTES < e.CHECKOUT_SESSION_MINUTES + 2) {
      problems.push('RESERVATION_MINUTES: debe superar la sesion en al menos 2 minutos');
    }
  }
  if (problems.length > 0) return err({ issues: problems });
  const sessionMinutes = e.CHECKOUT_SESSION_MINUTES ?? 30;
  const reservationMinutes = e.RESERVATION_MINUTES ?? sessionMinutes + 2;

  const config: AppConfig = {
    environment: e.APP_ENV,
    appName: e.PRODUCT_NAME ?? 'MarketLink',
    appUrl: e.APP_URL ?? 'http://localhost:3000',
    logLevel: e.LOG_LEVEL ?? 'info',
    flags: { paymentManualEnabled: e.PAYMENT_MANUAL_ENABLED, bizumEnabled: e.BIZUM_ENABLED },
    maxListingPriceCents: e.MAX_LISTING_PRICE_CENTS ?? 100_000,
    databaseUrl: new Secret(e.DATABASE_URL),
    databaseCaCert: e.DATABASE_CA_CERT?.replace(/\\n/g, '\n'),
    internalJobsSecret: new Secret(e.INTERNAL_JOBS_SECRET),
    rateLimitSalt: new Secret(e.RATE_LIMIT_SALT),
    monitorSecret: e.MONITOR_SECRET !== undefined ? new Secret(e.MONITOR_SECRET) : undefined,
    sessionCookieSecret: new Secret(e.SESSION_COOKIE_SECRET),
    e2eEnabled: e.E2E_ENABLED,
    supabase:
      e.SUPABASE_URL !== undefined &&
      e.SUPABASE_PUBLISHABLE_KEY !== undefined &&
      e.SUPABASE_SERVICE_ROLE_KEY !== undefined
        ? {
            url: e.SUPABASE_URL,
            publishableKey: e.SUPABASE_PUBLISHABLE_KEY,
            serviceRoleKey: new Secret(e.SUPABASE_SERVICE_ROLE_KEY),
          }
        : undefined,
    stripe:
      stripe !== undefined &&
      e.STRIPE_API_VERSION !== undefined &&
      e.STRIPE_CONNECT_WEBHOOK_SECRET !== undefined &&
      e.STRIPE_PLATFORM_WEBHOOK_SECRET !== undefined
        ? {
            secretKey: new Secret(stripe),
            apiVersion: e.STRIPE_API_VERSION,
            connectWebhookSecret: new Secret(e.STRIPE_CONNECT_WEBHOOK_SECRET),
            platformWebhookSecret: new Secret(e.STRIPE_PLATFORM_WEBHOOK_SECRET),
          }
        : undefined,
    packlink:
      e.PACKLINK_API_KEY !== undefined
        ? {
            apiKey: new Secret(e.PACKLINK_API_KEY),
            webhookSecret:
              e.PACKLINK_WEBHOOK_SECRET !== undefined
                ? new Secret(e.PACKLINK_WEBHOOK_SECRET)
                : undefined,
          }
        : undefined,
    email:
      e.RESEND_API_KEY !== undefined && e.EMAIL_FROM !== undefined && e.OPERATOR_EMAIL !== undefined
        ? {
            apiKey: new Secret(e.RESEND_API_KEY),
            from: e.EMAIL_FROM,
            operator: e.OPERATOR_EMAIL,
            sandboxRedirect: e.APP_ENV === 'live' ? undefined : e.EMAIL_SANDBOX_REDIRECT,
          }
        : undefined,
    tracking: {
      secret: new Secret(e.TRACKING_TOKEN_SECRET),
      previousSecret:
        e.TRACKING_TOKEN_SECRET_PREVIOUS !== undefined
          ? new Secret(e.TRACKING_TOKEN_SECRET_PREVIOUS)
          : undefined,
    },
    checkout: { sessionMinutes, reservationMinutes },
    shippingOptions: {
      quoteCacheTtlMinutes: e.QUOTE_CACHE_TTL_MINUTES ?? 10,
      unpaidDraftAlertHours: e.UNPAID_DRAFT_ALERT_HOURS ?? 24,
    },
    retention: {
      unpaidDays: e.RETENTION_UNPAID_DAYS ?? 30,
      personalMonths: e.RETENTION_PERSONAL_MONTHS ?? 12,
      financialYears: e.RETENTION_FINANCIAL_YEARS ?? 6,
      labelDays: e.RETENTION_LABEL_DAYS ?? 30,
      labelUndeliveredDays: e.RETENTION_LABEL_UNDELIVERED_DAYS ?? 90,
      notificationMonths: e.RETENTION_NOTIFICATION_MONTHS ?? 12,
    },
    contactEmail: e.CONTACT_EMAIL ?? 'contacto@example.com',
    alerts: {
      authFailures: e.ALERT_AUTH_FAILURES ?? 10,
      authzDenied: e.ALERT_AUTHZ_DENIED ?? 10,
      webhookSignatures: e.ALERT_WEBHOOK_SIGNATURES ?? 5,
    },
    operator,
    money: {
      payoutMode: e.PAYOUT_MODE ?? 'manual',
      settlementDelayHours: e.SETTLEMENT_DELAY_HOURS ?? 0,
      staleDeliveryDays: e.STALE_DELIVERY_DAYS ?? 10,
      blockedAlertDays: e.SETTLEMENT_BLOCKED_ALERT_DAYS ?? 7,
      recentLoginMinutes: e.RECENT_LOGIN_MINUTES ?? 15,
    },
  };
  return ok(deepFreeze(config));
};
