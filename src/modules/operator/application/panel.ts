import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Clock } from '@/modules/kernel/domain/clock';
import { Money } from '@/modules/kernel/domain/money';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { CreateShipmentDraft } from '@/modules/shipping/application/draft';
import type { RefundOrder } from '@/modules/payouts/application/refunds';
import type { ReleaseDelivery } from '@/modules/payouts/application/settlement';
import { REFUND_REASONS, type RefundReason } from '@/modules/payouts/domain/payouts';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { IdGenerator, Logger } from '@/modules/platform/application/ports';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import {
  enforceLimit,
  systemScope,
  type TransactionRunner,
} from '@/modules/platform/application/unit-of-work';
import type { Order } from '@/modules/orders/domain/order';
import {
  computeMetrics,
  countsAsVisit,
  validateSize,
  type Metrics,
  type SizeInput,
  type VisitRequest,
} from '../domain/settings-and-metrics';
import { stuckReason, type StuckReason } from '../domain/stuck';
import type { OperatorDirectory, VerifyOperatorTotp } from './access';
import type {
  DraftRow,
  OperatorActor,
  OperatorNote,
  OrderFilter,
  OrderFlag,
  OrderRow,
  PanelRepos,
} from './ports';

export const PAGE_SIZE = 25;

export type PanelDeps = {
  readonly runner: TransactionRunner<PanelRepos>;
  readonly directory: OperatorDirectory;
  readonly limiter: Pick<RateLimiter, 'check'>;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly staleDays: number;
  readonly totp: Pick<VerifyOperatorTotp, 'execute'>;
  readonly draft: Pick<CreateShipmentDraft, 'execute'>;
  readonly release: Pick<ReleaseDelivery, 'execute'>;
  readonly refund: Pick<RefundOrder, 'execute'>;
};

/** Sección de una página que puede no estar disponible sin tirar el resto (NFR-U6-22). */
export type Section<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

const forbidden = (): AppError => appError('forbidden');
const invalid = (field: string, reason: string): AppError =>
  appError('validation', { details: [{ field, reason }] });

/** Base común: rol comprobado en cada servicio, límites y auditoría (BR6-AC6, NFR-U6-10, 15). */
export abstract class PanelService {
  constructor(protected readonly deps: PanelDeps) {}

  protected allowed(actor: OperatorActor): boolean {
    return this.deps.directory.isAuthorized(actor.email);
  }

  /** Lecturas: 120 por minuto, fallo abierto. */
  protected async readLimit(actor: OperatorActor, correlationId: string): Promise<boolean> {
    const r = await enforceLimit(this.deps.limiter, 'operator_panel', actor.email, {
      failClosed: false,
      correlationId,
    });
    return r.ok;
  }

  /** Acciones que cambian datos: 10 por minuto, fallo cerrado. */
  protected async actionLimit(
    actor: OperatorActor,
    correlationId: string,
  ): Promise<Result<void, AppError>> {
    return enforceLimit(this.deps.limiter, 'operator_action', actor.email, {
      failClosed: true,
      correlationId,
    });
  }

  protected async section<T>(fn: () => Promise<T>): Promise<Section<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (cause) {
      this.deps.logger.warn('operator_section_failed', {
        reason: cause instanceof Error ? cause.name : 'unknown',
      });
      return { ok: false };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------
export type OrderListItem = OrderRow & { readonly stuck: StuckReason | undefined };

export class ListOrders extends PanelService {
  async execute(
    actor: OperatorActor,
    filter: OrderFilter,
    page: number,
    correlationId: string,
  ): Promise<
    Result<{ items: OrderListItem[]; total: number; page: number; pages: number }, AppError>
  > {
    if (!this.allowed(actor)) return err(forbidden());
    if (!(await this.readLimit(actor, correlationId))) return err(appError('rate_limited'));
    const now = this.deps.clock.now();
    const safePage = Math.max(1, Math.floor(page) || 1);
    const { rows, total } = await this.deps.runner.run(systemScope, (r) =>
      r.operator.listOrders(
        filter,
        PAGE_SIZE,
        (safePage - 1) * PAGE_SIZE,
        now,
        this.deps.staleDays,
      ),
    );
    return ok({
      items: rows.map((row) => ({ ...row, stuck: stuckReason(row, now, this.deps.staleDays) })),
      total,
      page: safePage,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  }

  async artists(actor: OperatorActor): Promise<{ id: string; name: string }[]> {
    if (!this.allowed(actor)) return [];
    try {
      return await this.deps.runner.run(systemScope, (r) => r.operator.listArtists());
    } catch {
      return [];
    }
  }
}

export class ListPendingDrafts extends PanelService {
  async execute(
    actor: OperatorActor,
    correlationId: string,
  ): Promise<Result<{ drafts: (DraftRow & { ageHours: number })[] }, AppError>> {
    if (!this.allowed(actor)) return err(forbidden());
    if (!(await this.readLimit(actor, correlationId))) return err(appError('rate_limited'));
    const now = this.deps.clock.now();
    const drafts = await this.deps.runner.run(systemScope, (r) => r.operator.listDrafts(100));
    return ok({
      drafts: drafts.map((d) => ({
        ...d,
        ageHours: Math.max(0, Math.floor((now - d.draftCreatedAt) / 3_600_000)),
      })),
    });
  }
}

export type Summary = { stuck: number; unpaidDrafts: number; openFlags: number };

export class GetOperatorSummary extends PanelService {
  async execute(
    actor: OperatorActor,
    correlationId: string,
  ): Promise<Result<{ counts: Section<Summary> }, AppError>> {
    if (!this.allowed(actor)) return err(forbidden());
    if (!(await this.readLimit(actor, correlationId))) return err(appError('rate_limited'));
    const now = this.deps.clock.now();
    const counts = await this.section(() =>
      this.deps.runner.run(systemScope, (r) => r.operator.counts(now, this.deps.staleDays)),
    );
    return ok({ counts });
  }
}

export type OrderDetail = {
  readonly order: Order;
  readonly artistName: Section<string>;
  readonly events: Section<
    {
      at: number;
      kind: string;
      actor: string;
      fromStatus: string;
      toStatus: string;
      reason: string | undefined;
    }[]
  >;
  readonly shipment: Section<
    | {
        status: string;
        incident: string | undefined;
        failureReason: string | undefined;
        providerRef: string | undefined;
        carrier: string | undefined;
        labelCostCents: number | undefined;
      }
    | undefined
  >;
  readonly money: Section<{
    settlement:
      { status: string; amountCents: number; blockReason: string | undefined } | undefined;
    refunds: { amountCents: number; status: string; reasonCode: string }[];
    marginCents: number | undefined;
  }>;
  readonly flags: Section<OrderFlag[]>;
  readonly notes: Section<OperatorNote[]>;
  readonly stuck: StuckReason | undefined;
};

export class GetOrderDetail extends PanelService {
  async execute(
    actor: OperatorActor,
    orderId: string,
    correlationId: string,
  ): Promise<Result<OrderDetail, AppError>> {
    const { deps } = this;
    if (!this.allowed(actor)) return err(forbidden());
    if (!(await this.readLimit(actor, correlationId))) return err(appError('rate_limited'));
    const order = await deps.runner.run(systemScope, (r) => r.orders.findById(orderId));
    if (!order) return err(appError('not_found'));
    // La ficha muestra datos personales: la consulta queda auditada antes de devolverlos.
    await deps.audit.record({
      actorType: 'operator',
      actorId: actor.email,
      action: 'operator_view_order',
      resourceType: 'order',
      resourceId: orderId,
      outcome: 'success',
      correlationId,
    });
    const run = <T>(fn: (r: PanelRepos) => Promise<T>) =>
      this.section(() => deps.runner.run(systemScope, fn));
    const [artistName, events, shipment, money, flags, notes] = await Promise.all([
      run(async (r) => (await r.artists.findById(order.artistId))?.artisticName ?? 'Sin nombre'),
      run(async (r) =>
        (await r.orderEvents.listByOrder(orderId)).map((e) => ({
          at: e.at,
          kind: e.kind,
          actor: e.actor,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          reason: e.reasonCode,
        })),
      ),
      run(async (r) => {
        const s = await r.shipments.findByOrder(orderId);
        return s
          ? {
              status: s.status,
              incident: s.incident,
              failureReason: s.failureReason,
              providerRef: s.providerRef,
              carrier: s.carrierName,
              labelCostCents: s.labelCostCents,
            }
          : undefined;
      }),
      run(async (r) => {
        const [settlement, refunds] = await Promise.all([
          r.settlements.findByOrder(orderId),
          r.refunds.listByOrder(orderId),
        ]);
        return {
          settlement: settlement
            ? {
                status: settlement.status,
                amountCents: settlement.amountCents,
                blockReason: settlement.blockReason,
              }
            : undefined,
          refunds: refunds.map((x) => ({
            amountCents: x.amountCents,
            status: x.status,
            reasonCode: x.reasonCode,
          })),
          marginCents: order.marginCents,
        };
      }),
      run((r) => r.operator.listFlags(orderId)),
      run((r) => r.operator.listNotes(orderId)),
    ]);
    const now = deps.clock.now();
    const stuck = stuckReason(
      {
        status: order.status,
        updatedAt: order.updatedAt,
        manualFlagOpen: flags.ok && flags.value.some((f) => f.closedAt === undefined),
        shipmentStatus: shipment.ok
          ? (shipment.value?.status as OrderRow['shipmentStatus'])
          : undefined,
        draftCreatedAt: undefined,
        pickupChosen: true,
        pickupRequestedAt: undefined,
        settlementBlocked: money.ok && money.value.settlement?.blockReason !== undefined,
      },
      now,
      deps.staleDays,
    );
    return ok({ order, artistName, events, shipment, money, flags, notes, stuck });
  }
}

// ---------------------------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------------------------
export type RetryOutcome = 'created' | 'waiting_pickup' | 'skipped' | 'failed';

export class RetryDraft extends PanelService {
  async execute(
    actor: OperatorActor,
    orderId: string,
    correlationId: string,
  ): Promise<Result<RetryOutcome, AppError>> {
    const { deps } = this;
    if (!this.allowed(actor)) return err(forbidden());
    const limited = await this.actionLimit(actor, correlationId);
    if (!limited.ok) return limited;
    const order = await deps.runner.run(systemScope, (r) => r.orders.findById(orderId));
    if (!order) return err(appError('not_found'));
    if (order.status !== 'error_borrador') return err(invalid('pedido', 'no_es_error_borrador'));

    const result = await deps.draft.execute(orderId, correlationId, false);
    const outcome: RetryOutcome = result.ok ? result.value : 'failed';
    const now = deps.clock.now();
    await deps.runner.run(systemScope, async (r) => {
      const fresh = await r.orders.findById(orderId);
      if (!fresh) return;
      await r.orderEvents.append({
        orderId,
        artistId: fresh.artistId,
        at: now,
        actor: 'operador',
        kind: 'borrador_reintentado',
        fromStatus: order.status,
        toStatus: fresh.status,
        reasonCode: outcome,
        externalRef: undefined,
      });
    });
    await deps.audit.record({
      actorType: 'operator',
      actorId: actor.email,
      action: 'operator_retry_draft',
      resourceType: 'order',
      resourceId: orderId,
      outcome: outcome === 'failed' ? 'failure' : 'success',
      correlationId,
      details: { outcome },
    });
    return ok(outcome);
  }
}

export class OpenFlag extends PanelService {
  async execute(
    actor: OperatorActor,
    orderId: string,
    rawReason: string,
    correlationId: string,
  ): Promise<Result<'opened' | 'already_open', AppError>> {
    const { deps } = this;
    if (!this.allowed(actor)) return err(forbidden());
    const reason = rawReason.trim();
    if (reason.length < 1 || reason.length > 120) return err(invalid('motivo', 'longitud'));
    const limited = await this.actionLimit(actor, correlationId);
    if (!limited.ok) return limited;
    const now = deps.clock.now();
    const result = await deps.runner.run(systemScope, async (r) => {
      if (!(await r.orders.findById(orderId))) return 'not_found' as const;
      const opened = await r.operator.openFlag({
        id: deps.ids.uuid(),
        orderId,
        reason,
        openedBy: actor.email,
        openedAt: now,
        resolution: undefined,
        closedBy: undefined,
        closedAt: undefined,
      });
      return opened ? ('opened' as const) : ('already_open' as const);
    });
    if (result === 'not_found') return err(appError('not_found'));
    if (result === 'opened') {
      await deps.audit.record({
        actorType: 'operator',
        actorId: actor.email,
        action: 'operator_flag_open',
        resourceType: 'order',
        resourceId: orderId,
        outcome: 'success',
        correlationId,
      });
    }
    return ok(result);
  }
}

export class CloseFlag extends PanelService {
  async execute(
    actor: OperatorActor,
    orderId: string,
    rawResolution: string,
    correlationId: string,
  ): Promise<Result<void, AppError>> {
    const { deps } = this;
    if (!this.allowed(actor)) return err(forbidden());
    const resolution = rawResolution.trim();
    if (resolution.length < 1 || resolution.length > 280)
      return err(invalid('resolucion', 'longitud'));
    const limited = await this.actionLimit(actor, correlationId);
    if (!limited.ok) return limited;
    const now = deps.clock.now();
    const closed = await deps.runner.run(systemScope, async (r) => {
      const flag = await r.operator.findOpenFlag(orderId);
      if (!flag) return false;
      const done = await r.operator.closeFlag(flag.id, actor.email, resolution, now);
      if (!done) return false;
      // Al cerrar la incidencia la liquidación pendiente se reintenta enseguida.
      const settlement = await r.settlements.findByOrderForUpdate(orderId);
      if (settlement?.status === 'pendiente') {
        await r.settlements.save({
          ...settlement,
          blockReason:
            settlement.blockReason === 'incidencia_abierta' ? undefined : settlement.blockReason,
          nextAttemptAt: now,
          updatedAt: now,
        });
      }
      return true;
    });
    if (!closed) return err(appError('not_found'));
    await deps.audit.record({
      actorType: 'operator',
      actorId: actor.email,
      action: 'operator_flag_close',
      resourceType: 'order',
      resourceId: orderId,
      outcome: 'success',
      correlationId,
    });
    return ok(undefined);
  }
}

export class AddNote extends PanelService {
  async execute(
    actor: OperatorActor,
    orderId: string,
    rawText: string,
    formKey: string,
    correlationId: string,
  ): Promise<Result<'added' | 'duplicate', AppError>> {
    const { deps } = this;
    if (!this.allowed(actor)) return err(forbidden());
    const text = rawText.trim();
    if (text.length < 1 || text.length > 500) return err(invalid('nota', 'longitud'));
    if (formKey.length < 8 || formKey.length > 64) return err(invalid('formulario', 'clave'));
    const limited = await this.actionLimit(actor, correlationId);
    if (!limited.ok) return limited;
    const now = deps.clock.now();
    const result = await deps.runner.run(systemScope, async (r) => {
      if (!(await r.orders.findById(orderId))) return 'not_found' as const;
      const added = await r.operator.addNote({
        id: deps.ids.uuid(),
        orderId,
        author: actor.email,
        at: now,
        text,
        formKey,
      });
      return added ? ('added' as const) : ('duplicate' as const);
    });
    if (result === 'not_found') return err(appError('not_found'));
    if (result === 'added') {
      await deps.audit.record({
        actorType: 'operator',
        actorId: actor.email,
        action: 'operator_note',
        resourceType: 'order',
        resourceId: orderId,
        outcome: 'success',
        correlationId,
      });
    }
    return ok(result);
  }
}

export type MoneyActionError =
  | 'forbidden'
  | 'rate_limited'
  | 'code_invalid'
  | 'locked'
  | 'validation'
  | 'incident_open'
  | 'refund_in_progress'
  | 'not_releasable'
  | 'reason_required'
  | 'already_settled'
  | 'exceeds_remaining'
  | 'not_refundable'
  | 'manual_payment'
  | 'no_payment'
  | 'settlement_in_progress'
  | 'provider_failed'
  | 'invalid_amount'
  | 'not_found';

export type MoneyActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MoneyActionError };

export class OperatorRelease extends PanelService {
  async execute(input: {
    readonly actor: OperatorActor;
    readonly orderId: string;
    readonly reason: string;
    readonly code: string;
    readonly correlationId: string;
  }): Promise<MoneyActionResult<{ settlement: string }>> {
    const { deps } = this;
    if (!this.allowed(input.actor)) return { ok: false, error: 'forbidden' };
    const reason = input.reason.trim();
    if (reason.length < 1 || reason.length > 60) return { ok: false, error: 'reason_required' };
    const limited = await this.actionLimit(input.actor, input.correlationId);
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
    const released = await deps.release.execute({
      orderId: input.orderId,
      reason,
      operatorId: input.actor.email,
      correlationId: input.correlationId,
    });
    await deps.audit.record({
      actorType: 'operator',
      actorId: input.actor.email,
      action: 'operator_release',
      resourceType: 'order',
      resourceId: input.orderId,
      outcome: released.ok ? 'success' : 'denied',
      correlationId: input.correlationId,
      details: { reason },
    });
    if (!released.ok) return { ok: false, error: released.error };
    return { ok: true, value: { settlement: released.settlement.kind } };
  }
}

export class OperatorRefund extends PanelService {
  async execute(input: {
    readonly actor: OperatorActor;
    readonly orderId: string;
    readonly amount: string;
    readonly reason: string;
    readonly code: string;
    readonly correlationId: string;
  }): Promise<MoneyActionResult<{ amountCents: number; total: boolean }>> {
    const { deps } = this;
    if (!this.allowed(input.actor)) return { ok: false, error: 'forbidden' };
    const amount = Money.parse(input.amount);
    if (!amount.ok || amount.value.cents <= 0) return { ok: false, error: 'invalid_amount' };
    if (!(REFUND_REASONS as readonly string[]).includes(input.reason)) {
      return { ok: false, error: 'validation' };
    }
    const limited = await this.actionLimit(input.actor, input.correlationId);
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
    const refunded = await deps.refund.execute({
      orderId: input.orderId,
      amountCents: amount.value.cents,
      reason: input.reason as RefundReason,
      operatorId: input.actor.email,
      correlationId: input.correlationId,
    });
    await deps.audit.record({
      actorType: 'operator',
      actorId: input.actor.email,
      action: 'operator_refund',
      resourceType: 'order',
      resourceId: input.orderId,
      outcome: refunded.ok ? 'success' : 'denied',
      correlationId: input.correlationId,
      details: { amountCents: amount.value.cents, reason: input.reason },
    });
    if (!refunded.ok) return { ok: false, error: refunded.error };
    return { ok: true, value: { amountCents: refunded.amountCents, total: refunded.total } };
  }
}

// ---------------------------------------------------------------------------------------------
// Tamaños, visitas y métricas
// ---------------------------------------------------------------------------------------------
export type SizeKey = 'S' | 'M' | 'L';
export const SIZE_KEYS: readonly SizeKey[] = ['S', 'M', 'L'];

export class GetSizeSettings extends PanelService {
  async execute(actor: OperatorActor) {
    if (!this.allowed(actor)) return err(forbidden());
    return ok(await this.deps.runner.run(systemScope, (r) => r.sizes.list()));
  }
}

export class SaveSizeSettings extends PanelService {
  async execute(
    actor: OperatorActor,
    values: Readonly<Record<SizeKey, SizeInput>>,
    correlationId: string,
  ): Promise<Result<{ changed: SizeKey[] }, AppError>> {
    const { deps } = this;
    if (!this.allowed(actor)) return err(forbidden());
    for (const key of SIZE_KEYS) {
      const checked = validateSize(values[key]);
      if (!checked.ok) return err(invalid(`tamano_${key}`, checked.error));
    }
    const limited = await this.actionLimit(actor, correlationId);
    if (!limited.ok) return limited;
    const now = deps.clock.now();
    const changed = await deps.runner.run(systemScope, async (r) => {
      const current = await r.sizes.list();
      const out: { key: SizeKey; before: SizeInput; after: SizeInput }[] = [];
      for (const key of SIZE_KEYS) {
        const before = current.find((c) => c.size === key);
        const after = values[key];
        if (
          before &&
          before.lengthCm === after.lengthCm &&
          before.widthCm === after.widthCm &&
          before.heightCm === after.heightCm &&
          before.weightKg === after.weightKg
        ) {
          continue;
        }
        await r.operator.saveSize(key, after, now);
        out.push({ key, before: before ?? after, after });
      }
      return out;
    });
    for (const c of changed) {
      await deps.audit.record({
        actorType: 'operator',
        actorId: actor.email,
        action: 'operator_sizes_changed',
        resourceType: 'size',
        resourceId: c.key,
        outcome: 'success',
        correlationId,
        details: { before: { ...c.before }, after: { ...c.after } },
      });
    }
    return ok({ changed: changed.map((c) => c.key) });
  }
}

/** Registro de visitas: mejor esfuerzo, con límite laxo y fallo abierto (NFR-U6-18, 19). */
export class RecordVisit {
  constructor(private readonly deps: Pick<PanelDeps, 'runner' | 'limiter' | 'clock' | 'logger'>) {}

  async execute(input: {
    readonly slug: string;
    readonly request: VisitRequest;
    readonly ip: string;
  }): Promise<'counted' | 'ignored' | 'limited' | 'failed'> {
    const { deps } = this;
    try {
      if (!countsAsVisit(input.request)) return 'ignored';
      const limited = await deps.limiter.check('listing_view', `${input.ip}|${input.slug}`, {
        failClosed: false,
        correlationId: 'visit',
      });
      if (!limited.ok) return 'limited';
      const day = new Date(deps.clock.now()).toISOString().slice(0, 10);
      await deps.runner.run(systemScope, (r) => r.operator.addView(input.slug, day));
      return 'counted';
    } catch {
      deps.logger.warn('visit_not_counted');
      return 'failed';
    }
  }
}

export type PeriodMetrics = { readonly current: Metrics; readonly previous: Metrics };

export class GetMetrics extends PanelService {
  async execute(
    actor: OperatorActor,
    from: number,
    to: number,
    correlationId: string,
  ): Promise<Result<Section<PeriodMetrics>, AppError>> {
    if (!this.allowed(actor)) return err(forbidden());
    if (!(await this.readLimit(actor, correlationId))) return err(appError('rate_limited'));
    if (!(to > from)) return err(invalid('periodo', 'rango'));
    const length = to - from;
    return ok(
      await this.section(async () => {
        const [current, previous] = await Promise.all([
          this.deps.runner.run(systemScope, (r) => r.operator.rawMetrics(from, to)),
          this.deps.runner.run(systemScope, (r) => r.operator.rawMetrics(from - length, from)),
        ]);
        return { current: computeMetrics(current), previous: computeMetrics(previous) };
      }),
    );
  }
}
