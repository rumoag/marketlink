'use server';

import { notFound, redirect } from 'next/navigation';
import { factsForFake } from '@/testing/e2e-doubles';
import { requestInfo, requireServices } from '@/ui/server-context';

const STATES = [
  'etiqueta',
  'transito',
  'entregado',
  'fallo_etiqueta',
  'fallo_transportista',
] as const;

/**
 * Hace avanzar el envio simulado y entrega al sistema los mismos hechos que traeria el webhook de
 * Packlink (se procesan en linea para que el E2E no dependa de la cola).
 */
export async function advanceShipmentAction(formData: FormData): Promise<void> {
  const services = requireServices();
  if (!services.e2e) notFound();
  const { correlationId } = await requestInfo();
  const ref = String(formData.get('ref') ?? '');
  const state = String(formData.get('state') ?? '');
  if (!(STATES as readonly string[]).includes(state)) notFound();

  const shipment = services.e2e.shipments.advance(ref, state as (typeof STATES)[number]);
  if (!shipment) notFound();
  for (const fact of factsForFake(shipment.state)) {
    await services.e2e.processShipmentFact.execute(ref, fact, correlationId);
  }
  redirect(`/e2e/envio/${ref}`);
}
