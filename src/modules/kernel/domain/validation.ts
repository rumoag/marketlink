import type { ZodType } from 'zod';
import { appError, type AppError, type FieldError } from './app-error';
import { err, ok, type Result } from './result';

/**
 * Valida con un esquema Zod y devuelve un `validation` con nombres de campo y motivo generico.
 * Nunca refleja el valor recibido (BR-R5).
 */
export const validate = <T>(schema: ZodType<T>, input: unknown): Result<T, AppError> => {
  const parsed = schema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const details: FieldError[] = parsed.error.issues.map((issue) => ({
    field: issue.path.join('.') || '(raiz)',
    reason: 'invalido',
  }));
  return err(appError('validation', { details }));
};
