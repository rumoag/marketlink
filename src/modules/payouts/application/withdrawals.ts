import { addMs, MS, type Clock, type Instant } from '@/modules/kernel/domain/clock';
import { planWithdrawalEntry, planWithdrawalReversal } from '@/modules/ledger/domain/ledger';
import { recipientOf } from '@/modules/notifications/domain/notification';
import type { OperatorAlerts } from '@/modules/orders/application/ports';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { IdGenerator, Logger } from '@/modules/platform/application/ports';
import type { RateLimiter } from '@/modules/platform/application/rate-limiter';
import { enforceLimit, systemScope } from '@/modules/platform/application/unit-of-work';
import type { Withdrawal } from '../domain/entities';
import {
  planWithdrawal,
  withdrawalKey,
  type PayoutMode,
  type WithdrawalError,
} from '../domain/payouts';
import { MoneyInvariantError, postEntries } from './post-entries';
import type { MoneyProvider } from './ports';
import type { MoneyRunner } from './settlement';

const PAYOUT_TIMEOUT_MS = 10_000;
const RESOLVE_AFTER_MS = 5 * MS.minute;
const MAX_RESOLVE_ATTEMPTS = 3;
const BATCH = 20;
const LEASE_MS = 5 * MS.minute;

export type WithdrawalDeps = {
  readonly runner: MoneyRunner;
  readonly provider: Pick<MoneyProvider, 'payout' | 'findPayout'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly audit: AuditLog;
  readonly alerts: OperatorAlerts;
  readonly logger: Logger;
  readonly mode: PayoutMode;
  readonly recentLoginMinutes: number;
  /** Regla `withdraw_artist` (5 por hora, fallo cerrado). */
  readonly limiter: Pick<RateLimiter, 'check'>;
};

export type WithdrawalResult =
  | {
      readonly ok: true;
      readonly status: 'enviada' | 'solicitada';
      readonly amountCents: number;
    }
  | {
      readonly ok: false;
      readonly error: WithdrawalError | 'account_not_active' | 'payout_failed' | 'rate_limited';
    };

const isDoubtful = (code: string): boolean =>
  code === 'dependency_unavailable' || code === 'rate_limited';

/** Notificacion de la retirada: sin pedido, con importe y referencia propia. */
const withdrawalNotice = (
  ids: IdGenerator,
  w: Pick<Withdrawal, 'id' | 'artistId' | 'amountCents'>,
  now: Instant,
) =>
  ({
    id: ids.uuid(),
    orderId: undefined,
    dedupeRef: w.id,
    amountCents: w.amountCents,
    artistId: w.artistId,
    type: 'retirada_artista' as const,
    recipientRole: recipientOf('retirada_artista'),
    status: 'pendiente' as const,
    attempts: 0,
    nextAttemptAt: now,
    lastError: undefined,
    createdAt: now,
    sentAt: undefined,
  }) as const;

/**
 * US-048: retirada del saldo disponible completo. El movimiento y la fila `solicitada` se
 * escriben antes de llamar al proveedor (BR5-WD3); la llamada va fuera de la transaccion, con
 * clave de idempotencia y limite de tiempo. Un resultado dudoso lo resuelve el trabajo.
 */
export class RequestWithdrawal {
  constructor(private readonly deps: WithdrawalDeps) {}

  async execute(input: {
    readonly artistId: string;
    readonly loginAt: number | undefined;
    readonly correlationId: string;
  }): Promise<WithdrawalResult> {
    const { deps } = this;
    const limited = await enforceLimit(deps.limiter, 'withdraw_artist', input.artistId, {
      failClosed: true,
      correlationId: input.correlationId,
    });
    if (!limited.ok) return { ok: false, error: 'rate_limited' };
    const opened = await deps.runner.run(systemScope, async (repos) => {
      const now = deps.clock.now();
      const balance = await repos.balances.lock(input.artistId);
      const open = await repos.withdrawals.findOpenByArtist(input.artistId);
      const plan = planWithdrawal({
        mode: deps.mode,
        balance,
        hasOpenWithdrawal: open !== undefined,
        loginAt: input.loginAt,
        now,
        recentLoginMinutes: deps.recentLoginMinutes,
      });
      if (!plan.ok) return { error: plan.error } as const;
      const account = await repos.payoutAccounts.find(input.artistId);
      if (!account?.active || account.providerAccountId === undefined) {
        return { error: 'account_not_active' } as const;
      }
      const seq = balance.withdrawalCount + 1;
      const entry = planWithdrawalEntry({
        artistId: input.artistId,
        seq,
        amountCents: plan.value.amountCents,
      });
      if (!entry.ok) throw new MoneyInvariantError(entry.error);
      const withdrawal: Withdrawal = {
        id: deps.ids.uuid(),
        artistId: input.artistId,
        seq,
        amountCents: plan.value.amountCents,
        status: 'solicitada',
        payoutRef: undefined,
        idempotencyKey: withdrawalKey(input.artistId, seq),
        attempts: 1,
        nextAttemptAt: addMs(now, RESOLVE_AFTER_MS),
        createdAt: now,
        completedAt: undefined,
      };
      await repos.withdrawals.insert(withdrawal);
      await postEntries(repos, [entry.value], now, {
        withdrawalIncrement: { artistId: input.artistId },
      });
      return { withdrawal, accountId: account.providerAccountId } as const;
    });
    if ('error' in opened) {
      return { ok: false, error: opened.error };
    }
    const { withdrawal, accountId } = opened;
    await deps.audit.record({
      actorType: 'artist',
      actorId: input.artistId,
      action: 'withdrawal_requested',
      resourceType: 'withdrawal',
      resourceId: withdrawal.id,
      outcome: 'success',
      correlationId: input.correlationId,
      details: { amountCents: withdrawal.amountCents },
    });

    const sent = await deps.provider.payout({
      accountId,
      amountCents: withdrawal.amountCents,
      idempotencyKey: withdrawal.idempotencyKey,
      timeoutMs: PAYOUT_TIMEOUT_MS,
    });
    if (sent.ok) {
      await this.markSent(withdrawal.id, sent.value.payoutRef, input.correlationId);
      return { ok: true, status: 'enviada', amountCents: withdrawal.amountCents };
    }
    if (isDoubtful(sent.error.code)) {
      // Resultado dudoso: se queda `solicitada` y el trabajo lo resuelve (BR5-RS2).
      return { ok: true, status: 'solicitada', amountCents: withdrawal.amountCents };
    }
    await this.revert(withdrawal.id, input.correlationId);
    return { ok: false, error: 'payout_failed' };
  }

  private async markSent(id: string, payoutRef: string, correlationId: string): Promise<void> {
    const { deps } = this;
    const w = await deps.runner.run(systemScope, async (repos) => {
      const now = deps.clock.now();
      const locked = await repos.withdrawals.findByIdForUpdate(id);
      if (!locked || locked.status !== 'solicitada') return undefined;
      const next: Withdrawal = {
        ...locked,
        status: 'enviada',
        payoutRef,
        nextAttemptAt: undefined,
        completedAt: now,
      };
      await repos.withdrawals.save(next);
      await repos.notifications.insertMany([withdrawalNotice(deps.ids, next, now)]);
      return next;
    });
    if (!w) return;
    await deps.audit.record({
      actorType: 'system',
      action: 'withdrawal_done',
      resourceType: 'withdrawal',
      resourceId: id,
      outcome: 'success',
      correlationId,
      details: { amountCents: w.amountCents },
    });
  }

  /** Fallo definitivo: movimiento compensatorio y retirada `fallida` (BR5-WD3). */
  async revert(id: string, correlationId: string): Promise<void> {
    const { deps } = this;
    const w = await deps.runner.run(systemScope, async (repos) => {
      const now = deps.clock.now();
      const locked = await repos.withdrawals.findByIdForUpdate(id);
      if (!locked || locked.status !== 'solicitada') return undefined;
      const back = planWithdrawalReversal({
        artistId: locked.artistId,
        seq: locked.seq,
        amountCents: locked.amountCents,
      });
      if (!back.ok) throw new MoneyInvariantError(back.error);
      await postEntries(repos, [back.value], now);
      const next: Withdrawal = {
        ...locked,
        status: 'fallida',
        nextAttemptAt: undefined,
        completedAt: now,
      };
      await repos.withdrawals.save(next);
      return next;
    });
    if (!w) return;
    await deps.audit.record({
      actorType: 'system',
      action: 'withdrawal_failed',
      resourceType: 'withdrawal',
      resourceId: id,
      outcome: 'failure',
      correlationId,
      details: { amountCents: w.amountCents },
    });
    await deps.alerts.raise('retirada_fallida', { detail: id }, correlationId);
  }

  /** Para el trabajo de resolucion. */
  async confirm(id: string, payoutRef: string, correlationId: string): Promise<void> {
    await this.markSent(id, payoutRef, correlationId);
  }
}

/**
 * Trabajo `withdraw_payout` (cada 5 minutos): resuelve las retiradas `solicitada` cuyo resultado
 * quedo dudoso. Primero busca el pago por su clave; si no existe, lo reintenta con la misma clave
 * (Stripe devuelve el mismo si ya se creo); agotados los intentos, restituye el saldo.
 */
export class ResolveWithdrawals {
  constructor(private readonly deps: WithdrawalDeps & { readonly requests: RequestWithdrawal }) {}

  async execute(
    correlationId: string,
  ): Promise<{ examined: number; sent: number; reverted: number; pending: number }> {
    const { deps } = this;
    const now = deps.clock.now();
    const due = await deps.runner.run(systemScope, (r) =>
      r.withdrawals.claimOpenDue(now, BATCH, LEASE_MS),
    );
    let sent = 0;
    let reverted = 0;
    let pending = 0;
    for (const w of due) {
      const account = await deps.runner.run(systemScope, (r) => r.payoutAccounts.find(w.artistId));
      const accountId = account?.providerAccountId;
      if (accountId === undefined) {
        await deps.requests.revert(w.id, correlationId);
        reverted += 1;
        continue;
      }
      const found = await deps.provider.findPayout(accountId, w.idempotencyKey);
      if (found.ok && found.value) {
        await deps.requests.confirm(w.id, found.value.payoutRef, correlationId);
        sent += 1;
        continue;
      }
      if (found.ok && w.attempts >= MAX_RESOLVE_ATTEMPTS) {
        await deps.requests.revert(w.id, correlationId);
        reverted += 1;
        continue;
      }
      // Reintento con la misma clave: seguro aunque la primera llamada hubiera llegado.
      const retried = await deps.provider.payout({
        accountId,
        amountCents: w.amountCents,
        idempotencyKey: w.idempotencyKey,
        timeoutMs: PAYOUT_TIMEOUT_MS,
      });
      if (retried.ok) {
        await deps.requests.confirm(w.id, retried.value.payoutRef, correlationId);
        sent += 1;
      } else if (isDoubtful(retried.error.code) && w.attempts < MAX_RESOLVE_ATTEMPTS) {
        await deps.runner.run(systemScope, async (repos) => {
          const locked = await repos.withdrawals.findByIdForUpdate(w.id);
          if (!locked || locked.status !== 'solicitada') return;
          await repos.withdrawals.save({
            ...locked,
            attempts: locked.attempts + 1,
            nextAttemptAt: addMs(deps.clock.now(), RESOLVE_AFTER_MS),
          });
        });
        pending += 1;
      } else {
        await deps.requests.revert(w.id, correlationId);
        reverted += 1;
      }
    }
    return { examined: due.length, sent, reverted, pending };
  }
}
