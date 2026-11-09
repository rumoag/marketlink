import type { Clock } from '@/modules/kernel/domain/clock';
import type { AuditLog } from '@/modules/platform/application/audit-log';
import { systemScope, type TransactionRunner } from '@/modules/platform/application/unit-of-work';
import { applyOrderTrigger } from '@/modules/orders/application/apply-trigger';
import type { OrdersRepos, PaymentProvider } from '@/modules/orders/application/ports';
import type { ProcessPaymentFact } from '@/modules/orders/application/process-payment-event';
import { factFromSession } from '@/modules/orders/application/process-payment-event';
import { hashResumeId, isWellFormedResumeId, resumeStillValid } from '../domain/consent';

/** Datos que rellenan el formulario tras cancelar (BR3-RT3). Sin la aceptacion de condiciones. */
export type ResumeForm = {
  readonly slug: string;
  readonly fields: Readonly<Record<string, string>>;
};

export type CancelOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'paid'; readonly sessionId: string | undefined }
  | { readonly kind: 'cancelled'; readonly form: ResumeForm | undefined };

export type CancelDeps = {
  readonly runner: TransactionRunner<OrdersRepos>;
  readonly provider: Pick<PaymentProvider, 'expireSession'>;
  readonly processor: Pick<ProcessPaymentFact, 'execute'>;
  readonly clock: Clock;
  readonly audit: AuditLog;
};

const toForm = async (
  repos: OrdersRepos,
  order: {
    listingId: string;
    buyer: { name: string; email: string; phone: string } | undefined;
    destination:
      | { street: string; complement: string; postalCode: string; city: string; province: string }
      | undefined;
  },
): Promise<ResumeForm | undefined> => {
  if (!order.buyer || !order.destination) return undefined;
  const listing = await repos.sales.findById(order.listingId);
  if (!listing) return undefined;
  return {
    slug: listing.slug,
    fields: {
      name: order.buyer.name,
      email: order.buyer.email,
      phone: order.buyer.phone,
      street: order.destination.street,
      complement: order.destination.complement,
      postalCode: order.destination.postalCode,
      city: order.destination.city,
      province: order.destination.province,
    },
  };
};

/** Vuelta desde Stripe sin pagar (US-020, BR3-RT1 a RT5). Idempotente. */
export class CancelCheckout {
  constructor(private readonly deps: CancelDeps) {}

  async execute(resumeId: string | undefined, correlationId: string): Promise<CancelOutcome> {
    if (resumeId === undefined || !isWellFormedResumeId(resumeId)) return { kind: 'none' };
    const hash = hashResumeId(resumeId);
    const now = this.deps.clock.now();
    const order = await this.deps.runner.run(systemScope, (repos) =>
      repos.orders.findByResumeHash(hash),
    );
    if (!order || !resumeStillValid(order.resumeExpiresAt, now)) return { kind: 'none' };
    if (order.status === 'pagado') return { kind: 'paid', sessionId: order.checkoutSessionId };

    if (order.status === 'pendiente_pago' && order.checkoutSessionId !== undefined) {
      // BR3-RT2: si la sesion ya estaba pagada no se cancela; se procesa y se va al exito.
      const expired = await this.deps.provider.expireSession(order.checkoutSessionId);
      if (expired.ok) {
        const fact = factFromSession(expired.value);
        if (fact?.kind === 'paid') {
          await this.deps.processor.execute({ ...fact, orderId: order.id }, correlationId);
          return { kind: 'paid', sessionId: order.checkoutSessionId };
        }
      }
    }

    return this.deps.runner.run(systemScope, async (repos) => {
      const locked = await repos.orders.findByIdForUpdate(order.id);
      if (!locked) return { kind: 'none' } as const;
      if (locked.status === 'pagado') {
        return { kind: 'paid', sessionId: locked.checkoutSessionId } as const;
      }
      await applyOrderTrigger(
        repos,
        locked,
        { type: 'cancelled_by_buyer' },
        {
          actor: 'comprador',
          now,
        },
      );
      return { kind: 'cancelled', form: await toForm(repos, locked) } as const;
    });
  }

  /** Lee el formulario de reintento para la pagina de la obra; es de un solo uso (BR3-RT3). */
  async consumeForm(resumeId: string | undefined, slug: string): Promise<ResumeForm | undefined> {
    if (resumeId === undefined || !isWellFormedResumeId(resumeId)) return undefined;
    const hash = hashResumeId(resumeId);
    const now = this.deps.clock.now();
    return this.deps.runner.run(systemScope, async (repos) => {
      const order = await repos.orders.findByResumeHash(hash);
      if (!order || !resumeStillValid(order.resumeExpiresAt, now)) return undefined;
      if (order.status !== 'cancelado' && order.status !== 'expirado') return undefined;
      const form = await toForm(repos, order);
      if (!form || form.slug !== slug) return undefined;
      // Un solo uso: el identificador deja de servir.
      const locked = await repos.orders.findByIdForUpdate(order.id);
      if (locked) {
        await repos.orders.save({
          ...locked,
          resumeHash: undefined,
          resumeExpiresAt: undefined,
          version: locked.version + 1,
          updatedAt: now,
        });
      }
      return form;
    });
  }
}
