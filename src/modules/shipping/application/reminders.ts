import type { Clock } from '@/modules/kernel/domain/clock';
import type { OperatorAlerts } from '@/modules/orders/application/ports';
import type { IdGenerator } from '@/modules/platform/application/ports';
import { systemScope } from '@/modules/platform/application/unit-of-work';
import { payReminderDue, pickupReminderDue } from '../domain/shipment';
import { buildNotifications, type ShippingRunner } from './apply-fact';

const BATCH = 50;

export type ReminderDeps = {
  readonly runner: ShippingRunner;
  readonly alerts: OperatorAlerts;
  readonly clock: Clock;
  readonly ids: IdGenerator;
};

/** BR4-RC3: recordatorio a las 24 h y aviso al operador a las 72 h si no se eligio recogida. */
export class RemindPickup {
  constructor(private readonly deps: ReminderDeps) {}

  async execute(correlationId: string): Promise<{ reminded: number; alerted: number }> {
    const now = this.deps.clock.now();
    let reminded = 0;
    let alerted = 0;
    const waiting = await this.deps.runner.run(systemScope, (repos) =>
      repos.shipments.listAwaitingPickup(BATCH),
    );
    for (const s of waiting) {
      const due = pickupReminderDue({
        chosen: s.pickup !== undefined,
        requestedAt: s.pickupRequestedAt,
        remindedAt: s.pickupRemindedAt,
        operatorAlertedAt: s.pickupOperatorAlertedAt,
        now,
      });
      if (due === 'ninguno') continue;
      const done = await this.deps.runner.run(systemScope, async (repos) => {
        const locked = await repos.shipments.findByOrderForUpdate(s.orderId);
        const order = await repos.orders.findById(s.orderId);
        if (!locked || !order || locked.pickup !== undefined || locked.status !== 'creando')
          return false;
        const again = pickupReminderDue({
          chosen: false,
          requestedAt: locked.pickupRequestedAt,
          remindedAt: locked.pickupRemindedAt,
          operatorAlertedAt: locked.pickupOperatorAlertedAt,
          now,
        });
        if (again !== due) return false;
        await repos.shipments.save(
          due === 'recordatorio'
            ? { ...locked, pickupRemindedAt: now, updatedAt: now }
            : { ...locked, pickupOperatorAlertedAt: now, updatedAt: now },
        );
        await repos.notifications.insertMany(
          buildNotifications(
            [
              due === 'recordatorio'
                ? 'recordatorio_recogida_artista'
                : 'recogida_sin_elegir_operador',
            ],
            order,
            now,
            this.deps.ids,
          ),
        );
        return true;
      });
      if (!done) continue;
      if (due === 'recordatorio') reminded += 1;
      else {
        alerted += 1;
        await this.deps.alerts.raise('recogida_sin_elegir', { orderId: s.orderId }, correlationId);
      }
    }
    return { reminded, alerted };
  }
}

/** BR4-PA2: si el borrador lleva 24 h sin pagarse se repite el aviso al operador una vez. */
export class RemindPayLabel {
  constructor(private readonly deps: ReminderDeps) {}

  async execute(correlationId: string): Promise<{ reminded: number }> {
    const now = this.deps.clock.now();
    let reminded = 0;
    const drafts = await this.deps.runner.run(systemScope, (repos) =>
      repos.shipments.listDrafts(BATCH),
    );
    for (const s of drafts) {
      if (
        !payReminderDue({
          draftCreatedAt: s.draftCreatedAt,
          remindedAt: s.payRemindedAt,
          status: s.status,
          now,
        })
      ) {
        continue;
      }
      const done = await this.deps.runner.run(systemScope, async (repos) => {
        const locked = await repos.shipments.findByOrderForUpdate(s.orderId);
        const order = await repos.orders.findById(s.orderId);
        if (!locked || !order || locked.status !== 'borrador' || locked.payRemindedAt !== undefined)
          return false;
        await repos.shipments.save({ ...locked, payRemindedAt: now, updatedAt: now });
        await repos.notifications.insertMany(
          buildNotifications(['recordatorio_pago_envio_operador'], order, now, this.deps.ids),
        );
        return true;
      });
      if (!done) continue;
      reminded += 1;
      await this.deps.alerts.raise('borrador_sin_pagar', { orderId: s.orderId }, correlationId);
    }
    return { reminded };
  }
}
