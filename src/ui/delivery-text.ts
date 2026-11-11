import type { DeliverySummary } from '@/modules/orders/domain/order';

/** Texto de «como se entrega»: sin destino (pedidos anteriores a U8) solo el servicio (BR8-H1). */
export const deliveryText = (d: DeliverySummary): string => {
  const who = d.carrier ? `${d.carrier} · ${d.serviceName}` : d.serviceName;
  const days = `${d.transitDays} ${d.transitDays === 1 ? 'día' : 'días'}`;
  if (d.destination === undefined) return who;
  return `${who} · ${d.destination === 'punto' ? 'entrega en un punto de recogida' : 'entrega a domicilio'} · ${days}`;
};
