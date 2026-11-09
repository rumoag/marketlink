import { MS } from '@/modules/kernel/domain/clock';

// ---------------------------------------------------------------------------------------------
// Alertas de seguridad (BR7-AL1, BR7-AL2)
// ---------------------------------------------------------------------------------------------
export type SecurityCounts = {
  readonly authFailures: number;
  readonly authzDenied: number;
  readonly webhookSignatures: number;
  readonly operatorLocked: number;
};

export type SecurityThresholds = {
  readonly authFailures: number;
  readonly authzDenied: number;
  readonly webhookSignatures: number;
};

export type SecurityAlertType =
  | 'seguridad_autenticacion'
  | 'seguridad_autorizacion'
  | 'seguridad_webhook'
  | 'acceso_operador_bloqueado';

export type SecurityFinding = {
  readonly type: SecurityAlertType;
  readonly count: number;
  readonly threshold: number;
};

/** Un hallazgo por cada tipo que alcanza su umbral (los bloqueos del operador: cualquiera). */
export const evaluateSecurity = (
  counts: SecurityCounts,
  thresholds: SecurityThresholds,
): SecurityFinding[] => {
  const out: SecurityFinding[] = [];
  if (counts.authFailures >= thresholds.authFailures) {
    out.push({
      type: 'seguridad_autenticacion',
      count: counts.authFailures,
      threshold: thresholds.authFailures,
    });
  }
  if (counts.authzDenied >= thresholds.authzDenied) {
    out.push({
      type: 'seguridad_autorizacion',
      count: counts.authzDenied,
      threshold: thresholds.authzDenied,
    });
  }
  if (counts.webhookSignatures >= thresholds.webhookSignatures) {
    out.push({
      type: 'seguridad_webhook',
      count: counts.webhookSignatures,
      threshold: thresholds.webhookSignatures,
    });
  }
  if (counts.operatorLocked >= 1) {
    out.push({ type: 'acceso_operador_bloqueado', count: counts.operatorLocked, threshold: 1 });
  }
  return out;
};

/** Franja de una hora a la que pertenece un instante (para avisar una vez por franja). */
export const hourBucket = (nowMs: number): string =>
  new Date(Math.floor(nowMs / MS.hour) * MS.hour).toISOString().slice(0, 13);

/** Filas de auditoria a partir de las cuales se avisa (BR7-AL3). */
export const AUDIT_ROWS_LIMIT = 1_000_000;

// ---------------------------------------------------------------------------------------------
// Estado de salud (BR7-SL2)
// ---------------------------------------------------------------------------------------------
export type HealthState = 'verde' | 'ambar' | 'rojo';

export type HealthSignals = {
  readonly dbOk: boolean;
  readonly failedJobs24h: number;
  readonly failedEmails: number;
  /** Horas desde la ultima copia conocida; `undefined` si no hay dato. */
  readonly backupAgeHours: number | undefined;
  readonly openCircuits: number;
  readonly quotasStale: boolean;
  /** En live la copia es obligatoria y un dato ausente cuenta como atencion. */
  readonly live: boolean;
};

export const BACKUP_WARN_HOURS = 36;
export const BACKUP_CRITICAL_HOURS = 72;
export const QUOTA_REVIEW_DAYS = 35;

export const HEALTH_LABEL: Readonly<Record<HealthState, string>> = {
  verde: 'Correcto',
  ambar: 'Atención',
  rojo: 'Crítico',
};

/**
 * Funcion pura y monotona (P-U7-08): empeorar cualquier senal nunca mejora el estado.
 * Devuelve ademas los motivos legibles.
 */
export const healthStatus = (s: HealthSignals): { state: HealthState; reasons: string[] } => {
  const critical: string[] = [];
  const warn: string[] = [];
  if (!s.dbOk) critical.push('La base de datos no responde');
  if (s.live && s.backupAgeHours !== undefined && s.backupAgeHours > BACKUP_CRITICAL_HOURS) {
    critical.push(`La última copia tiene más de ${BACKUP_CRITICAL_HOURS} horas`);
  }
  if (s.failedJobs24h > 0) warn.push(`${s.failedJobs24h} trabajos fallidos en 24 horas`);
  if (s.failedEmails > 0) warn.push(`${s.failedEmails} correos fallidos`);
  if (s.backupAgeHours !== undefined && s.backupAgeHours > BACKUP_WARN_HOURS) {
    warn.push(`La última copia tiene más de ${BACKUP_WARN_HOURS} horas`);
  }
  if (s.live && s.backupAgeHours === undefined) warn.push('No hay registro de ninguna copia');
  if (s.openCircuits > 0) warn.push(`${s.openCircuits} proveedores con el circuito abierto`);
  if (s.quotasStale) warn.push(`Cuotas sin revisar hace más de ${QUOTA_REVIEW_DAYS} días`);
  if (critical.length > 0) return { state: 'rojo', reasons: [...critical, ...warn] };
  if (warn.length > 0) return { state: 'ambar', reasons: warn };
  return { state: 'verde', reasons: [] };
};

/** Revisión de cuotas: vencida si no hay fecha o pasaron más de 35 días. */
export const quotaReviewStatus = (
  reviewedAtMs: number | undefined,
  nowMs: number,
): 'al_dia' | 'vencida' =>
  reviewedAtMs === undefined || nowMs - reviewedAtMs > QUOTA_REVIEW_DAYS * MS.day
    ? 'vencida'
    : 'al_dia';

// ---------------------------------------------------------------------------------------------
// Textos legales desde la configuracion (BR7-PD7, NFR-U7-05)
// ---------------------------------------------------------------------------------------------
export type PrivacyConfig = {
  readonly personalMonths: number;
  readonly unpaidDays: number;
  readonly financialYears: number;
  readonly contactEmail: string;
};

export type PrivacyFacts = PrivacyConfig & {
  readonly retention: string;
  readonly unpaid: string;
  readonly financial: string;
  readonly rights: string;
};

/** Los textos de plazos salen de la configuración: si cambia el plazo, cambia el texto. */
export const privacyFacts = (c: PrivacyConfig): PrivacyFacts => ({
  ...c,
  unpaid: `Si no llegas a pagar, borramos tus datos a los ${c.unpaidDays} días.`,
  retention: `Si compras, conservamos tus datos ${c.personalMonths} meses desde la entrega para posibles reclamaciones y después los eliminamos.`,
  financial: `Los importes (sin datos personales) se guardan ${c.financialYears} años, el tiempo que exige la ley.`,
  rights: `Puedes pedir acceso, rectificación o supresión de tus datos escribiendo a ${c.contactEmail}.`,
});
