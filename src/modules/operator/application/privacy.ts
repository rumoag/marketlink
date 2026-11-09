import type { Clock } from '@/modules/kernel/domain/clock';
import { purgePersonalData } from '@/modules/orders/domain/order';
import {
  isRetentionDue,
  isRetentionStatus,
  purgeBlock,
  retentionReference,
  type PurgeBlock,
  type PurgeMode,
} from '@/modules/orders/domain/retention';
import type { OperatorAlerts } from '@/modules/orders/application/ports';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { Logger } from '@/modules/platform/application/ports';
import {
  enforceLimit,
  systemScope,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import type { OperatorDirectory, VerifyOperatorTotp } from './access';
import type { OperatorActor, PanelRepos } from './ports';

const BATCH = 50;

export type PurgeOutcome =
  | { readonly kind: 'purged' }
  | { readonly kind: 'already' }
  | { readonly kind: 'not_due' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'blocked'; readonly block: PurgeBlock };

export type PurgeDeps = {
  readonly runner: TransactionRunner<PanelRepos>;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly alerts: OperatorAlerts;
  readonly logger: Logger;
  /** Meses de retención desde la entrega (BR7-PD1). */
  readonly months: number;
};

/**
 * BR7-PD1 a PD5: limpia los datos personales de un pedido. Una transacción por pedido, con la
 * fila bloqueada y la elegibilidad recalculada con el estado fresco. Idempotente.
 */
export class PurgePersonalData {
  constructor(private readonly deps: PurgeDeps) {}

  async purgeOne(
    orderId: string,
    mode: PurgeMode,
    reason: string,
    correlationId: string,
    actorEmail?: string,
  ): Promise<PurgeOutcome> {
    const { deps } = this;
    const now = deps.clock.now();
    const outcome = await deps.runner.run(systemScope, async (r): Promise<PurgeOutcome> => {
      const order = await r.orders.findByIdForUpdate(orderId);
      if (!order) return { kind: 'not_found' };
      if (order.personalPurgedAt !== undefined || (!order.buyer && !order.destination)) {
        return { kind: 'already' };
      }
      if (mode === 'retention') {
        if (!isRetentionStatus(order.status)) return { kind: 'not_due' };
        const events = await r.orderEvents.listByOrder(orderId);
        const paid = events.find(
          (e) => e.kind === 'pago_confirmado' || e.kind === 'cobro_manual_confirmado',
        );
        const shipment = await r.shipments.findByOrder(orderId);
        const reference = retentionReference({
          deliveredAt: shipment?.deliveredAt,
          paidAt: paid?.at,
          createdAt: order.createdAt,
        });
        if (!isRetentionDue(reference, now, deps.months)) return { kind: 'not_due' };
      }
      const [refunds, settlement, flagOpen] = await Promise.all([
        r.refunds.listByOrder(orderId),
        r.settlements.findByOrder(orderId),
        r.manualFlags.hasOpen(orderId),
      ]);
      const block = purgeBlock(mode, {
        status: order.status,
        refundPending: refunds.some((x) => x.status === 'solicitado'),
        manualFlagOpen: flagOpen,
        settlementPending: settlement?.status === 'pendiente',
      });
      if (block) return { kind: 'blocked', block };

      const next = purgePersonalData(order, now);
      const saved = await r.orders.save({ ...next, version: order.version + 1 });
      if (!saved) throw new Error('concurrent_order_update');
      await r.orderEvents.append({
        orderId,
        artistId: order.artistId,
        at: now,
        actor: mode === 'retention' ? 'sistema' : 'operador',
        kind: 'datos_purgados',
        fromStatus: order.status,
        toStatus: order.status,
        reasonCode: mode === 'retention' ? 'retencion' : reason.slice(0, 60),
        externalRef: undefined,
      });
      return { kind: 'purged' };
    });
    if (outcome.kind === 'purged') {
      await deps.audit.record({
        actorType: mode === 'retention' ? 'system' : 'operator',
        ...(actorEmail ? { actorId: actorEmail } : {}),
        action: mode === 'retention' ? 'personal_data_purged' : 'personal_data_erased',
        resourceType: 'order',
        resourceId: orderId,
        outcome: 'success',
        correlationId,
        details: mode === 'retention' ? { count: 1 } : { reason: reason.slice(0, 60) },
      });
    }
    return outcome;
  }

  /** Trabajo diario: lotes de 50 hasta no quedar candidatos (con tope de seguridad). */
  async runBatch(
    correlationId: string,
  ): Promise<{ purged: number; waiting: number; failed: number }> {
    const { deps } = this;
    const now = deps.clock.now();
    let purged = 0;
    let waiting = 0;
    let failed = 0;
    const seen = new Set<string>();
    for (let round = 0; round < 100; round += 1) {
      const batch = (
        await deps.runner.run(systemScope, (r) =>
          r.operator.listPurgeCandidates(now, deps.months, BATCH * 4),
        )
      ).filter((c) => !seen.has(c.orderId));
      if (batch.length === 0) break;
      for (const c of batch.slice(0, BATCH)) {
        seen.add(c.orderId);
        try {
          const o = await this.purgeOne(c.orderId, 'retention', 'retencion', correlationId);
          if (o.kind === 'purged') purged += 1;
          else if (o.kind === 'blocked') waiting += 1;
        } catch (cause) {
          failed += 1;
          deps.logger.warn('purge_personal_data_failed', {
            correlationId,
            reason: cause instanceof Error ? cause.name : 'unknown',
          });
        }
      }
      if (batch.length <= BATCH) break;
    }
    if (failed > 0) {
      await deps.alerts.raise('limpieza_datos_fallida', { detail: `${failed}` }, correlationId);
    }
    return { purged, waiting, failed };
  }
}

export type EraseError =
  'forbidden' | 'rate_limited' | 'code_invalid' | 'locked' | 'reason_required' | 'not_found';

export type EraseResult =
  | { readonly ok: true; readonly status: 'purged' | 'already' }
  | { readonly ok: false; readonly error: EraseError }
  | { readonly ok: false; readonly error: 'blocked'; readonly block: PurgeBlock };

/** Borrado a petición (BR7-PD4): motivo, código TOTP fresco y límite de acciones del panel. */
export class ErasePersonalData {
  constructor(
    private readonly deps: {
      readonly purge: Pick<PurgePersonalData, 'purgeOne'>;
      readonly directory: OperatorDirectory;
      readonly totp: Pick<VerifyOperatorTotp, 'execute'>;
      readonly limiter: Pick<RateLimiter, 'check'>;
    },
  ) {}

  async execute(input: {
    readonly actor: OperatorActor;
    readonly orderId: string;
    readonly reason: string;
    readonly code: string;
    readonly correlationId: string;
  }): Promise<EraseResult> {
    const { deps } = this;
    if (!deps.directory.isAuthorized(input.actor.email)) return { ok: false, error: 'forbidden' };
    const reason = input.reason.trim();
    if (reason.length < 1 || reason.length > 60) return { ok: false, error: 'reason_required' };
    const limited = await enforceLimit(deps.limiter, 'operator_action', input.actor.email, {
      failClosed: true,
      correlationId: input.correlationId,
    });
    if (!limited.ok) return { ok: false, error: 'rate_limited' };
    const verified = await deps.totp.execute({
      email: input.actor.email,
      code: input.code,
      purpose: 'money',
      correlationId: input.correlationId,
    });
    if (!verified.ok) {
      return { ok: false, error: verified.error === 'locked' ? 'locked' : 'code_invalid' };
    }
    const out = await deps.purge.purgeOne(
      input.orderId,
      'on_demand',
      reason,
      input.correlationId,
      input.actor.email,
    );
    if (out.kind === 'not_found') return { ok: false, error: 'not_found' };
    if (out.kind === 'blocked') return { ok: false, error: 'blocked', block: out.block };
    return { ok: true, status: out.kind === 'purged' ? 'purged' : 'already' };
  }
}
