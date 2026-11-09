import pino from 'pino';
import { redact } from '../domain/redactor';
import type { LogFields, Logger } from '../application/ports';

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger JSON a la salida estandar (BR-G1). Toda entrada pasa por la redaccion de BR-G2
 * antes de escribirse. Es la unica forma de registrar en codigo de servidor.
 */
export const createLogger = (options: { level: Level; service?: string }): Logger => {
  const base = pino({
    level: options.level,
    base: { service: options.service ?? 'marketlink' },
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Segunda barrera por si algun campo conocido llega sin pasar por `wrap`.
    redact: {
      paths: ['*.authorization', '*.password', '*.token', '*.secret'],
      censor: '[REDACTED]',
    },
  });

  const wrap = (instance: pino.Logger): Logger => {
    const write = (level: Level, message: string, fields?: LogFields): void => {
      const safeFields = (redact(fields ?? {}) ?? {}) as Record<string, unknown>;
      instance[level](safeFields, redact(message) as string);
    };
    return {
      debug: (m, f) => write('debug', m, f),
      info: (m, f) => write('info', m, f),
      warn: (m, f) => write('warn', m, f),
      error: (m, f) => write('error', m, f),
      child: (bindings) => wrap(instance.child(redact(bindings) as Record<string, unknown>)),
    };
  };

  return wrap(base);
};
