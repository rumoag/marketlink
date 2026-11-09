import type { AccountsRepos } from '@/modules/accounts/application/ports';
import type { ListingsRepos } from '@/modules/listings/application/ports';
import type { PayoutsRepos } from '@/modules/payouts/application/ports';
import type { OperatorRepos } from '@/modules/operator/application/ports';
import type { OrdersRepos } from '@/modules/orders/application/ports';
import type { ShippingRepos } from '@/modules/shipping/application/ports';

/**
 * Todos los repositorios de una transaccion. La capa de coordinacion es la unica que ve los
 * modulos a la vez (ACC, LST, ORD y SHP no se importan entre si salvo SHP hacia ORD y NTF).
 */
export type AppRepos = AccountsRepos &
  ListingsRepos &
  OrdersRepos &
  ShippingRepos &
  PayoutsRepos &
  OperatorRepos;
