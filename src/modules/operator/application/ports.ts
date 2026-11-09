import type { AccountsRepos } from '@/modules/accounts/application/ports';
import type { ListingsRepos } from '@/modules/listings/application/ports';
import type { PayoutsRepos } from '@/modules/payouts/application/ports';
import type { ShippingRepos } from '@/modules/shipping/application/ports';
import type { OrderStatus } from '@/modules/orders/domain/order';
import type { RawMetrics } from '../domain/settings-and-metrics';
import type { StuckInput } from '../domain/stuck';

/** Persona que actúa en el panel: el email ya validado por la sesión de operador. */
export type OperatorActor = { readonly email: string };

export type TotpState = {
  readonly email: string;
  readonly lastStep: number;
  readonly failures: number;
  readonly windowStart: number | undefined;
  readonly lockedUntil: number | undefined;
};

export type OrderFlag = {
  readonly id: string;
  readonly orderId: string;
  readonly reason: string;
  readonly openedBy: string;
  readonly openedAt: number;
  readonly resolution: string | undefined;
  readonly closedBy: string | undefined;
  readonly closedAt: number | undefined;
};

export type OperatorNote = {
  readonly id: string;
  readonly orderId: string;
  readonly author: string;
  readonly at: number;
  readonly text: string;
  readonly formKey: string | undefined;
};

export type OrderFilter = {
  readonly status?: OrderStatus | undefined;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly artistId?: string | undefined;
  readonly stuckOnly?: boolean | undefined;
};

/** Fila de la lista: sin datos personales. */
export type OrderRow = StuckInput & {
  readonly id: string;
  readonly createdAt: number;
  readonly artistId: string;
  readonly artistName: string;
  readonly title: string;
  readonly totalCents: number;
  readonly providerRef: string | undefined;
};

export type DraftRow = {
  readonly orderId: string;
  readonly providerRef: string | undefined;
  readonly draftCreatedAt: number;
  readonly title: string;
};

export type SizeValues = {
  readonly lengthCm: number;
  readonly widthCm: number;
  readonly heightCm: number;
  readonly weightKg: number;
};

/** Candidato a limpieza: pedido con datos personales y su fecha de referencia. */
export type PurgeCandidate = { readonly orderId: string };

export type JobStats = {
  readonly failed24h: number;
  readonly pending: number;
  readonly running: number;
};
export type EmailStats = { readonly pending: number; readonly failed: number };
export type BackupRun = { readonly at: number; readonly sizeBytes: number };

export interface OperatorRepository {
  // --- U7 ---------------------------------------------------------------------------------
  /**
   * Pedidos con datos personales que pueden haber vencido (prefiltro generoso: el servicio
   * recalcula con la funcion pura). Solo estados que no gestiona la limpieza de sin pagar.
   */
  listPurgeCandidates(now: number, months: number, limit: number): Promise<PurgeCandidate[]>;
  /** Conteo de eventos de seguridad desde un instante. */
  securityCounts(since: number): Promise<{
    authFailures: number;
    authzDenied: number;
    webhookSignatures: number;
    operatorLocked: number;
  }>;
  /** ¿Hay ya un aviso de ese codigo en esa franja? */
  hasAlertInBucket(code: string, bucket: string): Promise<boolean>;
  /** Estimacion barata del numero de filas de auditoria. */
  auditRows(): Promise<number>;
  jobStats(now: number): Promise<JobStats>;
  emailStats(): Promise<EmailStats>;
  alertStats(since: number): Promise<{ code: string; n: number }[]>;
  blockedSettlements(): Promise<number>;
  lastBackup(): Promise<BackupRun | undefined>;
  dbPing(): Promise<boolean>;

  // Segundo factor
  getTotpState(email: string): Promise<TotpState | undefined>;
  /** Fija el paso solo si es mayor que el último aceptado (una sola sentencia); `true` si lo fijó. */
  acceptStep(email: string, step: number, now: number): Promise<boolean>;
  /** Suma un fallo (reinicia la ventana si venció) y bloquea al llegar al máximo. */
  recordFailure(
    email: string,
    now: number,
    windowMs: number,
    max: number,
    lockMs: number,
  ): Promise<TotpState>;
  resetFailures(email: string, now: number): Promise<void>;
  // Incidencias y notas
  findOpenFlag(orderId: string): Promise<OrderFlag | undefined>;
  listFlags(orderId: string): Promise<OrderFlag[]>;
  /** `false` si ya hay una abierta (índice único). */
  openFlag(flag: OrderFlag): Promise<boolean>;
  closeFlag(id: string, closedBy: string, resolution: string, now: number): Promise<boolean>;
  /** `false` si la clave del formulario ya se usó. */
  addNote(note: OperatorNote): Promise<boolean>;
  listNotes(orderId: string): Promise<OperatorNote[]>;
  // Listas
  listOrders(
    filter: OrderFilter,
    limit: number,
    offset: number,
    now: number,
    staleDays: number,
  ): Promise<{ rows: OrderRow[]; total: number }>;
  listDrafts(limit: number): Promise<DraftRow[]>;
  counts(
    now: number,
    staleDays: number,
  ): Promise<{ stuck: number; unpaidDrafts: number; openFlags: number }>;
  listArtists(): Promise<{ id: string; name: string }[]>;
  // Tamaños
  saveSize(size: 'S' | 'M' | 'L', values: SizeValues, now: number): Promise<boolean>;
  // Visitas y métricas
  /** Suma una visita a la obra de ese slug (ya validado) en el dia indicado. */
  addView(slug: string, day: string): Promise<boolean>;
  purgeViews(beforeDay: string): Promise<number>;
  rawMetrics(from: number, to: number): Promise<RawMetrics>;
}

export type OperatorRepos = { readonly operator: OperatorRepository };

/** Todo lo que ve una transacción del panel. */
export type PanelRepos = PayoutsRepos &
  ShippingRepos &
  Pick<ListingsRepos, 'sizes'> &
  Pick<AccountsRepos, 'artists'> &
  OperatorRepos;

/** Cola de trabajos (para el envío del enlace y los avisos). */
export type JobSink = (input: {
  type: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
}) => Promise<unknown>;
