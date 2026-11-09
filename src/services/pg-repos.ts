import { createAccountsRepos } from '@/modules/accounts/infrastructure/pg-repositories';
import type { Clock } from '@/modules/kernel/domain/clock';
import { createListingsRepos } from '@/modules/listings/infrastructure/pg-repositories';
import {
  PgArtistContactRepository,
  PgOrderEventStore,
  PgOrderRepository,
} from '@/modules/orders/infrastructure/pg-repositories';
import { PgNotificationRepository } from '@/modules/notifications/infrastructure/pg-repositories';
import { PgShipmentRepository } from '@/modules/shipping/infrastructure/pg-repositories';
import {
  PgBalanceRepository,
  PgLedgerRepository,
  PgRefundRepository,
  PgSettlementRepository,
  PgWithdrawalRepository,
} from '@/modules/payouts/infrastructure/pg-repositories';
import {
  PgManualFlagReader,
  PgOperatorRepository,
} from '@/modules/operator/infrastructure/pg-repositories';
import type { IdGenerator } from '@/modules/platform/application/ports';
import type { Queryable } from '@/modules/platform/infrastructure/pg-runner';
import { createListingSales } from './listing-sales';
import type { AppRepos } from './repos';

export type AppReposDeps = { readonly clock: Clock; readonly ids: IdGenerator };

/** Compone los repositorios de ACC, LST y ORD sobre la misma transaccion. */
export const createAppRepos =
  (deps: AppReposDeps) =>
  (q: Queryable): AppRepos => {
    const base = { ...createAccountsRepos(q), ...createListingsRepos(q) };
    return {
      ...base,
      orders: new PgOrderRepository(q),
      orderEvents: new PgOrderEventStore(q),
      contacts: new PgArtistContactRepository(q),
      sales: createListingSales(base, deps.clock, deps.ids),
      shipments: new PgShipmentRepository(q),
      notifications: new PgNotificationRepository(q),
      operator: new PgOperatorRepository(q),
      manualFlags: new PgManualFlagReader(q),
      ledger: new PgLedgerRepository(q),
      balances: new PgBalanceRepository(q),
      settlements: new PgSettlementRepository(q),
      withdrawals: new PgWithdrawalRepository(q),
      refunds: new PgRefundRepository(q),
      payoutAccounts: {
        find: async (artistId) => {
          const rec = await base.payouts.find(artistId);
          return rec
            ? {
                providerAccountId: rec.providerAccountId,
                active: rec.state.status === 'activo',
              }
            : undefined;
        },
      },
    };
  };
