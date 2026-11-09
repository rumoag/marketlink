import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { JobQueue } from '@/modules/jobs/application/job-queue';
import { JobHandlerRegistry } from '@/modules/jobs/application/job-queue';
import { LoggingOperatorNotifier } from '@/modules/platform/application/operator-notifier';
import { unwrap } from '@/modules/kernel/domain/result';
import type { AccountSnapshot } from '@/modules/accounts/domain/payout';
import {
  IngestAccountEvent,
  JOB_APPLY_ACCOUNT_EVENT,
  parsePayload,
  type AccountEventPayload,
  type WebhookEventStore,
} from '@/services/ingest-account-event';
import { JOB_NOTIFY_PAYOUT_RESTRICTED, registerU2Jobs } from '@/services/job-handlers';
import { buildHarness } from '@tests/support/harness';
import { MemoryJobStore } from '@tests/support/memory-job-store';
import { snapshotArb } from '@tests/support/u2-generators';

class MemoryWebhookStore implements WebhookEventStore {
  readonly events = new Map<string, { payload: AccountEventPayload; processed: boolean }>();
  insertIfNew(
    _p: 'stripe',
    eventId: string,
    _t: string,
    payload: AccountEventPayload,
  ): Promise<boolean> {
    if (this.events.has(eventId)) return Promise.resolve(false);
    this.events.set(eventId, { payload, processed: false });
    return Promise.resolve(true);
  }
  markProcessed(eventId: string): Promise<void> {
    const e = this.events.get(eventId);
    if (e) e.processed = true;
    return Promise.resolve();
  }
}

const ACCOUNT = 'acct_TEST';

/** Cableado completo del flujo: ruta (ingesta) -> tabla -> cola -> trabajo -> caso de uso. */
const buildFlow = async () => {
  const h = buildHarness();
  const artistId = await h.readyArtist();
  const record = h.db.state.payouts.get(artistId);
  h.db.state.payouts.set(artistId, {
    ...(record as NonNullable<typeof record>),
    providerAccountId: ACCOUNT,
  });
  // Dos enlaces activos: una restriccion debe pausarlos una sola vez.
  await h.createListing(artistId);
  await h.createListing(artistId);

  const store = new MemoryWebhookStore();
  const jobStore = new MemoryJobStore();
  const registry = new JobHandlerRegistry();
  const queue = new JobQueue({
    store: jobStore,
    registry,
    clock: h.clock,
    logger: h.logger,
    audit: undefined as never,
    notifier: new LoggingOperatorNotifier(h.logger),
  });
  const enqueue = (input: { type: string; payload: Record<string, unknown>; dedupeKey: string }) =>
    queue.enqueue(input);
  registerU2Jobs(registry, {
    apply: h.apply,
    provider: h.payout,
    photos: h.photos,
    enqueue,
    notifier: new LoggingOperatorNotifier(h.logger),
    markProcessed: (id) => store.markProcessed(id),
    logger: h.logger,
  });
  const ingest = new IngestAccountEvent({
    provider: h.payout,
    store,
    enqueue,
    audit: { record: () => Promise.resolve() } as never,
    logger: h.logger,
  });

  /**
   * Los eventos de cuenta v2 son finos: solo traen la cuenta y el instante. El estado lo da el
   * proveedor al procesar el trabajo (`h.payout.snapshots`), que cada prueba fija a su gusto.
   */
  const send = (event: { id: string; snapshot: AccountSnapshot }, signature = 'valid') =>
    ingest.handle(
      JSON.stringify({
        id: event.id,
        type: 'v2.core.account[requirements].updated',
        providerAccountId: ACCOUNT,
        occurredAt: event.snapshot.eventAt,
      }),
      signature,
      'c',
    );
  const setProviderState = (snapshot: AccountSnapshot) => h.payout.snapshots.set(ACCOUNT, snapshot);
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      const r = await queue.runBatch({ correlationId: 'c', limit: 50 });
      if (r.claimed === 0) return;
    }
  };
  return { h, artistId, store, jobStore, send, drain, setProviderState };
};

describe('R-08 webhooks de cuenta duplicados y desordenados', () => {
  it('una firma invalida se rechaza sin guardar nada ni encolar', async () => {
    const f = await buildFlow();
    const result = await f.send(
      { id: 'evt_1', snapshot: { ...f.h.enabledSnapshot(f.h.clock.now() + 10), disabled: true } },
      'falsa',
    );
    expect(result).toBe('invalid_signature');
    expect(f.store.events.size).toBe(0);
    expect(f.jobStore.jobs.size).toBe(0);
  });

  it('un evento repetido se ignora y un tipo desconocido se confirma sin efecto', async () => {
    const f = await buildFlow();
    const event = {
      id: 'evt_1',
      snapshot: { ...f.h.enabledSnapshot(f.h.clock.now() + 10), disabled: true },
    };
    expect(await f.send(event)).toBe('accepted');
    expect(await f.send(event)).toBe('duplicate');
    expect(f.jobStore.jobs.size).toBe(1);
    expect(await f.h.payout.parseEvent(JSON.stringify({ ignore: true }), 'valid')).toEqual({
      ok: true,
      value: null,
    });
  });

  it('el flujo completo pausa los enlaces una sola vez y avisa una sola vez', async () => {
    const f = await buildFlow();
    const event = {
      id: 'evt_9',
      snapshot: { ...f.h.enabledSnapshot(f.h.clock.now() + 10), disabled: true },
    };
    f.setProviderState(event.snapshot);
    await f.send(event);
    await f.send(event); // duplicado
    await f.drain();

    const listings = [...f.h.db.state.listings.values()];
    expect(
      listings.every((l) => l.status === 'pausado' && l.pausedReason === 'cobros_restringidos'),
    ).toBe(true);
    expect(f.h.db.state.payouts.get(f.artistId)?.state.status).toBe('restringido');
    const alerts = f.h.logger.entries.filter((e) => e.message === 'operator_alert');
    expect(alerts).toHaveLength(1);
    expect([...f.store.events.values()].every((e) => e.processed)).toBe(true);
  });

  it('los eventos reordenados y repetidos dejan el estado del evento mas reciente (propiedad)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(snapshotArb(fc.integer({ min: 1, max: 10_000 })), {
          selector: (s) => s.eventAt,
          minLength: 1,
          maxLength: 6,
        }),
        fc.nat(),
        async (snapshots, shuffleSeed) => {
          const f = await buildFlow();
          const base = f.h.clock.now();
          const events = snapshots.map((s, i) => ({
            id: `evt_${i}`,
            snapshot: { ...s, eventAt: base + s.eventAt },
          }));
          // Orden de llegada arbitrario y con duplicados.
          const arrival = [...events, ...events.filter((_, i) => (i + shuffleSeed) % 2 === 0)].sort(
            (a, b) =>
              ((a.snapshot.eventAt * 31 + shuffleSeed) % 7) -
              ((b.snapshot.eventAt * 31 + shuffleSeed) % 7),
          );
          for (const e of arrival) await f.send(e);
          // El proveedor ya esta en el estado del evento mas reciente cuando se procesan los trabajos.
          const latest = events.reduce((a, b) => (b.snapshot.eventAt > a.snapshot.eventAt ? b : a));
          f.setProviderState(latest.snapshot);
          await f.drain();

          // Cada evento distinto genera como mucho un trabajo y una fila (idempotencia).
          expect(f.store.events.size).toBe(events.length);
          const applyJobs = [...f.jobStore.jobs.values()].filter(
            (j) => j.type === JOB_APPLY_ACCOUNT_EVENT,
          );
          expect(applyJobs).toHaveLength(events.length);

          const payout = f.h.db.state.payouts.get(f.artistId)?.state;
          expect(payout?.lastEventAt).toBe(latest.snapshot.eventAt);
          const enabled =
            latest.snapshot.transfersActive &&
            latest.snapshot.payoutsEnabled &&
            !latest.snapshot.disabled;
          expect(payout?.status === 'activo').toBe(enabled);
          expect(payout?.status === 'restringido').toBe(!enabled);

          // Los enlaces solo se pausan al restringirse y nunca se reactivan solos.
          const listings = [...f.h.db.state.listings.values()];
          const everRestricted = [...f.jobStore.jobs.values()].some(
            (j) => j.type === JOB_NOTIFY_PAYOUT_RESTRICTED,
          );
          expect(listings.every((l) => l.status === 'pausado')).toBe(everRestricted);
          if (!enabled) expect(listings.every((l) => l.status !== 'activo')).toBe(true);
          // Una alerta por transicion a restringido, como mucho una por evento.
          expect(
            f.h.logger.entries.filter((e) => e.message === 'operator_alert').length,
          ).toBeLessThanOrEqual(events.length);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('un fallo al consultar el estado de la cuenta reintenta el trabajo y luego lo aplica', async () => {
    const f = await buildFlow();
    const event = {
      id: 'evt_r',
      snapshot: { ...f.h.enabledSnapshot(f.h.clock.now() + 10), disabled: true },
    };
    f.setProviderState(event.snapshot);
    await f.send(event);
    f.h.payout.down = true;
    await f.drain();
    // Sin proveedor no se aplica nada y el evento sigue pendiente de procesar.
    expect(f.h.db.state.payouts.get(f.artistId)?.state.status).not.toBe('restringido');
    expect([...f.store.events.values()].every((e) => !e.processed)).toBe(true);

    f.h.payout.down = false;
    f.h.clock.advance(10 * 60_000); // pasa la espera del reintento
    await f.drain();
    expect(f.h.db.state.payouts.get(f.artistId)?.state.status).toBe('restringido');
    expect([...f.store.events.values()].every((e) => e.processed)).toBe(true);
  });

  it('un trabajo que leyo un estado antiguo no pisa al que ya aplico uno mas reciente', async () => {
    const f = await buildFlow();
    const t = f.h.clock.now();
    const disabled = { ...f.h.enabledSnapshot(t + 20), disabled: true };
    // Un primer evento se procesa con el proveedor deshabilitado...
    f.setProviderState(disabled);
    await f.send({ id: 'evt_new', snapshot: disabled });
    await f.drain();
    expect(f.h.db.state.payouts.get(f.artistId)?.state.status).toBe('restringido');
    // ...y otro evento anterior que llega tarde lee el estado actual: no cambia nada.
    f.setProviderState(f.h.enabledSnapshot(t + 5)); // lectura con un instante anterior
    await f.send({ id: 'evt_old', snapshot: f.h.enabledSnapshot(t + 5) });
    await f.drain();
    expect(f.h.db.state.payouts.get(f.artistId)?.state.status).toBe('restringido');
  });

  it('parsePayload rechaza cargas mal formadas', () => {
    expect(parsePayload(null)).toBeUndefined();
    expect(parsePayload({ providerAccountId: 'a' })).toBeUndefined();
    expect(parsePayload({ providerAccountId: '', occurredAt: 5 })).toBeUndefined();
    expect(parsePayload({ providerAccountId: 'a', occurredAt: 'x' })).toBeUndefined();
    expect(parsePayload({ providerAccountId: 'a', occurredAt: Number.NaN })).toBeUndefined();
    const ok = parsePayload({ providerAccountId: 'a', occurredAt: 5 });
    expect(unwrap({ ok: true as const, value: ok })).toEqual({
      providerAccountId: 'a',
      occurredAt: 5,
    });
  });
});
