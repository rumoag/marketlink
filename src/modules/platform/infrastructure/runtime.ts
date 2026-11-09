import { systemClock } from '@/modules/kernel/domain/clock';
import { ErrorHandler } from '../application/error-handler';
import { AuditLog } from '../application/audit-log';
import { loadConfig, type AppConfig } from '../application/config';
import { LoggingOperatorNotifier, type OperatorNotifier } from '../application/operator-notifier';
import type { Logger } from '../application/ports';
import { RATE_LIMIT_RULES, RateLimiter } from '../application/rate-limiter';
import { getDb, type Db } from './db-client';
import { ResilientHttpClient } from './http-client';
import { createLogger } from './logger';
import { PgAuditStore, PgCounterStore } from './pg-stores';
import { createSubjectHasher } from './subject-hasher';

const DEFAULT_APP_NAME = 'MarketLink';

/** Raiz de composicion: crea una sola vez los servicios de plataforma. */
export type Runtime = {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Db;
  readonly audit: AuditLog;
  readonly errors: ErrorHandler;
  readonly notifier: OperatorNotifier;
  readonly http: ResilientHttpClient;
  readonly limiter: RateLimiter;
};

const g = globalThis as unknown as { __marketlinkRuntime?: Runtime };

export const getRuntime = (env: NodeJS.ProcessEnv = process.env): Runtime | undefined => {
  if (g.__marketlinkRuntime) return g.__marketlinkRuntime;
  const loaded = loadConfig(env);
  if (!loaded.ok) {
    // Solo nombres de variable: nunca valores (BR-K6).
    createLogger({ level: 'error' }).error('config_invalid', { issues: loaded.error.issues });
    return undefined;
  }
  const config = loaded.value;
  const logger = createLogger({ level: config.logLevel });
  const db = getDb(config);
  const audit = new AuditLog(new PgAuditStore(db), logger, systemClock);
  g.__marketlinkRuntime = {
    config,
    logger,
    db,
    audit,
    errors: new ErrorHandler(logger, audit),
    notifier: new LoggingOperatorNotifier(logger),
    http: new ResilientHttpClient({ clock: systemClock, logger }),
    limiter: new RateLimiter({
      store: new PgCounterStore(db),
      hasher: createSubjectHasher(config.rateLimitSalt.reveal()),
      clock: systemClock,
      audit,
      logger,
      // Solo pruebas E2E (la configuracion rechaza E2E_ENABLED en live): todas las pruebas salen de
      // 127.0.0.1 y agotarian los limites por IP; los limites reales se prueban en unitarias.
      ...(config.e2eEnabled
        ? {
            rules: Object.fromEntries(
              Object.entries(RATE_LIMIT_RULES).map(([name, rule]) => [
                name,
                { ...rule, limit: rule.limit * 1000 },
              ]),
            ),
          }
        : {}),
    }),
  };
  return g.__marketlinkRuntime;
};

/** Nombre del producto (BR-E3). No crea conexiones ni registra: valido tambien en la compilacion. */
export const getAppName = (env: NodeJS.ProcessEnv = process.env): string => {
  const loaded = loadConfig(env);
  return loaded.ok ? loaded.value.appName : DEFAULT_APP_NAME;
};
