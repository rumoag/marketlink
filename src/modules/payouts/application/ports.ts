import type { AppError } from '@/modules/kernel/domain/app-error';
import type { Instant } from '@/modules/kernel/domain/clock';
import type { Result } from '@/modules/kernel/domain/result';
import type { LedgerEntry, LedgerEntryRow } from '@/modules/ledger/domain/ledger';
import type { NotificationRepository } from '@/modules/notifications/application/ports';
import type { OrdersRepos } from '@/modules/orders/application/ports';
import type { ArtistBalance, Refund, Settlement, Withdrawal } from '../domain/entities';

export interface LedgerRepository {
  /** Inserta los movimientos cuya clave no exista; devuelve las claves nuevas (idempotente). */
  insertMany(entries: readonly LedgerEntry[], at: Instant): Promise<readonly string[]>;
  listByOrder(orderId: string): Promise<LedgerEntryRow[]>;
  listByArtist(artistId: string, limit: number): Promise<LedgerEntryRow[]>;
  /** Sistema: saldos recalculados desde el libro, por artista. */
  sumsByArtist(): Promise<{ artistId: string; retainedCents: number; availableCents: number }[]>;
  /** Sistema: pedidos cuya conservacion no se cumple. */
  orderGaps(): Promise<{ orderId: string; gapCents: number }[]>;
  /** Sistema: movimientos con `from <= at < to` para la exportacion. */
  listBetween(from: Instant, to: Instant): Promise<LedgerEntryRow[]>;
}

export interface BalanceRepository {
  /** Bloquea la fila de la artista (la crea a cero si falta). */
  lock(artistId: string): Promise<ArtistBalance>;
  find(artistId: string): Promise<ArtistBalance | undefined>;
  save(balance: ArtistBalance, now: Instant): Promise<void>;
  listAll(): Promise<ArtistBalance[]>;
}

export interface SettlementRepository {
  /** Crea la liquidacion si el pedido no tiene; devuelve falso si ya existia. */
  insertIfAbsent(settlement: Settlement): Promise<boolean>;
  findByOrder(orderId: string): Promise<Settlement | undefined>;
  findByOrderForUpdate(orderId: string): Promise<Settlement | undefined>;
  save(settlement: Settlement): Promise<void>;
  /** Pendientes vencidas, reservadas `leaseMs` (SKIP LOCKED): exclusivo entre ejecutores. */
  claimDue(now: Instant, limit: number, leaseMs: number): Promise<Settlement[]>;
  listByArtist(artistId: string, limit: number): Promise<Settlement[]>;
  /** Sistema: creadas con `from <= createdAt < to` (exportacion). */
  listBetween(from: Instant, to: Instant): Promise<Settlement[]>;
  /** Pendientes creadas antes de `before` y aun sin aviso al operador. */
  listBlockedUnalerted(before: Instant, limit: number): Promise<Settlement[]>;
}

export interface WithdrawalRepository {
  insert(withdrawal: Withdrawal): Promise<void>;
  findOpenByArtist(artistId: string): Promise<Withdrawal | undefined>;
  findByIdForUpdate(id: string): Promise<Withdrawal | undefined>;
  save(withdrawal: Withdrawal): Promise<void>;
  listByArtist(artistId: string, limit: number): Promise<Withdrawal[]>;
  /** Sistema: creadas con `from <= createdAt < to` (exportacion). */
  listBetween(from: Instant, to: Instant): Promise<Withdrawal[]>;
  /** `solicitada` con `nextAttemptAt` vencido, reservadas `leaseMs`. */
  claimOpenDue(now: Instant, limit: number, leaseMs: number): Promise<Withdrawal[]>;
}

export interface RefundRepository {
  insert(refund: Refund): Promise<void>;
  listByOrder(orderId: string): Promise<Refund[]>;
  findByIdForUpdate(id: string): Promise<Refund | undefined>;
  save(refund: Refund): Promise<void>;
  /** Sistema: reembolsos hechos o solicitados desde `since` (exportacion). */
  listBetween(from: Instant, to: Instant): Promise<Refund[]>;
}

/** Estado de la cuenta de cobros de la artista (U2), leido con la forma que necesita el dinero. */
export interface PayoutAccountReader {
  find(
    artistId: string,
  ): Promise<{ providerAccountId: string | undefined; active: boolean } | undefined>;
}

/** Incidencia manual del operador (U6): mientras esta abierta no se libera ni se liquida. */
export interface ManualFlagReader {
  hasOpen(orderId: string): Promise<boolean>;
}

export type PayoutsRepos = OrdersRepos & {
  readonly manualFlags: ManualFlagReader;
  readonly ledger: LedgerRepository;
  readonly balances: BalanceRepository;
  readonly settlements: SettlementRepository;
  readonly withdrawals: WithdrawalRepository;
  readonly refunds: RefundRepository;
  readonly payoutAccounts: PayoutAccountReader;
  readonly notifications: NotificationRepository;
};

// ---------------------------------------------------------------------------------------------
// Proveedor del dinero (Stripe)
// ---------------------------------------------------------------------------------------------
export interface MoneyProvider {
  /** Cobro (`ch_...`) del pago y su metodo real; `undefined` si aun no existe. */
  chargeOf(
    paymentIntentId: string,
  ): Promise<
    Result<{ chargeId: string; method: 'tarjeta' | 'bizum' | undefined } | undefined, AppError>
  >;
  /** Transferencia a la cuenta de la artista ligada al cobro; idempotente por clave. */
  transfer(input: {
    readonly orderId: string;
    readonly destinationAccountId: string;
    readonly amountCents: number;
    readonly chargeId: string;
    readonly idempotencyKey: string;
  }): Promise<Result<{ transferRef: string }, AppError>>;
  /** Transferencia ya creada para el pedido (por grupo de transferencia), si existe. */
  findTransfer(orderId: string): Promise<Result<{ transferRef: string } | undefined, AppError>>;
  /** Pago a banco desde la cuenta de la artista; idempotente por clave. */
  payout(input: {
    readonly accountId: string;
    readonly amountCents: number;
    readonly idempotencyKey: string;
    readonly timeoutMs: number;
  }): Promise<Result<{ payoutRef: string }, AppError>>;
  findPayout(
    accountId: string,
    idempotencyKey: string,
  ): Promise<Result<{ payoutRef: string } | undefined, AppError>>;
  /** Reembolso parcial o total del pago; idempotente por clave. */
  refund(input: {
    readonly paymentIntentId: string;
    readonly amountCents: number;
    readonly idempotencyKey: string;
  }): Promise<Result<{ refundRef: string }, AppError>>;
}

/** Guarda las exportaciones contables mensuales (bucket privado). */
export interface FinanceExportStorage {
  put(key: string, csv: string): Promise<Result<void, AppError>>;
}
