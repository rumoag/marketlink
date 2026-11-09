import {
  appError,
  ERROR_CODES,
  GENERIC_MESSAGES,
  httpStatusFor,
  type AppError,
  type FieldError,
} from '@/modules/kernel/domain/app-error';
import { redact } from '../domain/redactor';
import type { AuditLog } from './audit-log';
import type { Logger } from './ports';

export type ErrorBody = {
  readonly error: {
    readonly code: AppError['code'];
    readonly message: string;
    readonly correlationId: string;
    readonly details?: readonly FieldError[];
  };
};

export type ErrorResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ErrorBody;
};

const isAppError = (e: unknown): e is AppError =>
  typeof e === 'object' &&
  e !== null &&
  'code' in e &&
  typeof (e as { code: unknown }).code === 'string' &&
  (ERROR_CODES as readonly string[]).includes((e as { code: string }).code);

/** Cualquier cosa que no sea un AppError conocido se trata como `internal` (BR-R4, falla cerrado). */
export const normalizeError = (e: unknown): AppError => (isAppError(e) ? e : appError('internal'));

/**
 * BR-R3: construye la respuesta. El mensaje siempre sale de la tabla generica por codigo,
 * nunca del error recibido, para no filtrar detalles internos.
 */
export const toErrorResponse = (error: AppError, correlationId: string): ErrorResponse => {
  const headers: Record<string, string> = { 'x-correlation-id': correlationId };
  if (error.code === 'rate_limited' && error.retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(Math.max(1, Math.ceil(error.retryAfterSeconds)));
  }
  return {
    status: httpStatusFor(error.code),
    headers,
    body: {
      error: {
        code: error.code,
        message: GENERIC_MESSAGES[error.code],
        correlationId,
        ...(error.code === 'validation' && error.details !== undefined
          ? { details: error.details.map((d) => ({ field: d.field, reason: d.reason })) }
          : {}),
      },
    },
  };
};

export class ErrorHandler {
  constructor(
    private readonly logger: Logger,
    private readonly audit: AuditLog,
  ) {}

  /** Manejador global: registra el detalle (ya redactado) y responde de forma generica. */
  async handle(
    cause: unknown,
    context: { correlationId: string; actorId?: string; resource?: string },
  ): Promise<ErrorResponse> {
    const error = normalizeError(cause);
    this.logger.error('request_error', {
      code: error.code,
      correlationId: context.correlationId,
      cause: redact(cause),
    });
    if (error.code === 'unauthenticated' || error.code === 'forbidden') {
      await this.audit.record({
        actorType: context.actorId ? 'artist' : 'anonymous',
        ...(context.actorId ? { actorId: context.actorId } : {}),
        action: error.code === 'unauthenticated' ? 'auth_failure' : 'authz_denied',
        ...(context.resource ? { resourceType: 'route', resourceId: context.resource } : {}),
        outcome: 'denied',
        correlationId: context.correlationId,
      });
    }
    return toErrorResponse(error, context.correlationId);
  }
}
