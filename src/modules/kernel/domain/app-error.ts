import { err, type Err } from './result';

/** Conjunto cerrado de codigos de error (BR-R2). */
export const ERROR_CODES = [
  'validation',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'dependency_unavailable',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type FieldError = { readonly field: string; readonly reason: string };

export type AppError = {
  readonly code: ErrorCode;
  /** Mensaje generico: nunca contiene trazas, rutas, tablas ni datos personales. */
  readonly message: string;
  readonly retryable: boolean;
  /** Solo para `validation`: nombres de campo y motivo generico (BR-R5). */
  readonly details?: readonly FieldError[];
  /** Solo para `rate_limited`: segundos hasta que termina la ventana. */
  readonly retryAfterSeconds?: number;
};

export const GENERIC_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  validation: 'Los datos enviados no son válidos.',
  unauthenticated: 'Necesitas iniciar sesión.',
  forbidden: 'No tienes permiso para hacer esto.',
  not_found: 'No hemos encontrado lo que buscas.',
  conflict: 'La operación no se puede completar en el estado actual.',
  rate_limited: 'Demasiadas peticiones. Prueba de nuevo más tarde.',
  dependency_unavailable: 'El servicio no está disponible ahora. Prueba de nuevo más tarde.',
  internal: 'Ha ocurrido un error. Prueba de nuevo más tarde.',
};

/** BR-R3: traduccion de codigo a estado HTTP; cualquier otro -> 500. */
const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  dependency_unavailable: 503,
  internal: 500,
};

export const ALLOWED_HTTP_STATUSES: readonly number[] = [...new Set(Object.values(HTTP_STATUS))];

export const httpStatusFor = (code: ErrorCode): number => HTTP_STATUS[code] ?? 500;

export type AppErrorOptions = {
  readonly retryable?: boolean;
  readonly details?: readonly FieldError[];
  readonly retryAfterSeconds?: number;
};

const DEFAULT_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  validation: false,
  unauthenticated: false,
  forbidden: false,
  not_found: false,
  conflict: false,
  rate_limited: true,
  dependency_unavailable: true,
  internal: false,
};

/** Construye un AppError con mensaje generico; el mensaje nunca lo decide quien llama. */
export const appError = (code: ErrorCode, options: AppErrorOptions = {}): AppError => ({
  code,
  message: GENERIC_MESSAGES[code],
  retryable: options.retryable ?? DEFAULT_RETRYABLE[code],
  ...(options.details !== undefined ? { details: options.details } : {}),
  ...(options.retryAfterSeconds !== undefined
    ? { retryAfterSeconds: options.retryAfterSeconds }
    : {}),
});

export const failure = (code: ErrorCode, options: AppErrorOptions = {}): Err<AppError> =>
  err(appError(code, options));

/** Errores propios de las operaciones de Money (se mapean a `validation` en los bordes). */
export type MoneyErrorCode = 'overflow' | 'negative_result' | 'invalid_amount' | 'out_of_range';
