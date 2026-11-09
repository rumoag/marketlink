import type { Instant } from '@/modules/kernel/domain/clock';
import type { RefundStatus, SettlementBlock, SettlementStatus, WithdrawalStatus } from './payouts';

/** Entidades de dinero (U5). Sin datos personales: solo identificadores, importes y referencias opacas. */
export type Settlement = {
  readonly id: string;
  readonly orderId: string;
  readonly artistId: string;
  readonly amountCents: number;
  readonly status: SettlementStatus;
  readonly blockReason: SettlementBlock | undefined;
  readonly transferRef: string | undefined;
  readonly attempts: number;
  readonly nextAttemptAt: Instant;
  readonly releasedBy: 'automatica' | 'manual' | undefined;
  readonly alertedAt: Instant | undefined;
  readonly createdAt: Instant;
  readonly completedAt: Instant | undefined;
  readonly updatedAt: Instant;
};

export type Withdrawal = {
  readonly id: string;
  readonly artistId: string;
  readonly seq: number;
  readonly amountCents: number;
  readonly status: WithdrawalStatus;
  readonly payoutRef: string | undefined;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly nextAttemptAt: Instant | undefined;
  readonly createdAt: Instant;
  readonly completedAt: Instant | undefined;
};

export type Refund = {
  readonly id: string;
  readonly orderId: string;
  readonly seq: number;
  readonly amountCents: number;
  readonly shippingPartCents: number;
  readonly artistPartCents: number;
  readonly status: RefundStatus;
  readonly refundRef: string | undefined;
  readonly reasonCode: string;
  readonly requestedBy: 'operador' | 'sistema';
  readonly createdAt: Instant;
  readonly completedAt: Instant | undefined;
};

export type ArtistBalance = {
  readonly artistId: string;
  readonly retainedCents: number;
  readonly availableCents: number;
  readonly withdrawalCount: number;
};
