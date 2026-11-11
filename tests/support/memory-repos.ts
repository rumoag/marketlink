import { systemClock, type Clock, type Instant } from '@/modules/kernel/domain/clock';
import type { Email } from '@/modules/kernel/domain/formats';
import type { AccountsRepos, PayoutRecord } from '@/modules/accounts/application/ports';
import type {
  AddressInput,
  Artist,
  ProfileInput,
  SenderAddress,
} from '@/modules/accounts/domain/artist';
import type { InstagramHandle } from '@/modules/accounts/domain/instagram-handle';
import type { PeninsularPostalCode } from '@/modules/accounts/domain/postal';
import type { PayoutState } from '@/modules/accounts/domain/payout';
import {
  SlugTakenError,
  type ArtistEligibility,
  type ListingsRepos,
  type PhotoUpload,
  type PublicArtist,
  type SizePreset,
  type StoredPhoto,
} from '@/modules/listings/application/ports';
import {
  countsTowardLimit,
  type Listing,
  type ListingDraft,
} from '@/modules/listings/domain/listing';
import type { Reservation } from '@/modules/listings/domain/reservation';
import type { Slug } from '@/modules/listings/domain/slug';
import type { Scope, TransactionRunner } from '@/modules/platform/application/unit-of-work';
import { SubmissionKeyTakenError, type OrdersRepos } from '@/modules/orders/application/ports';
import { SWEEP_GRACE_MS, type Order, type OrderEvent } from '@/modules/orders/domain/order';
import type { Notification } from '@/modules/notifications/domain/notification';
import type { LedgerEntryRow } from '@/modules/ledger/domain/ledger';
import type {
  OperatorNote,
  OperatorRepos,
  OrderFlag,
  OrderRow,
  TotpState,
} from '@/modules/operator/application/ports';
import { stuckReason } from '@/modules/operator/domain/stuck';
import type { ManualFlagReader } from '@/modules/payouts/application/ports';
import type { PayoutsRepos } from '@/modules/payouts/application/ports';
import type {
  ArtistBalance,
  Refund,
  Settlement,
  Withdrawal,
} from '@/modules/payouts/domain/entities';
import type { Shipment } from '@/modules/shipping/domain/entity';
import type { ShippingRepos } from '@/modules/shipping/application/ports';
import type { IdGenerator } from '@/modules/platform/application/ports';
import { createListingSales } from '@/services/listing-sales';
import type { AppRepos } from '@/services/repos';

export type MemState = {
  artists: Map<string, Artist>;
  addresses: Map<string, SenderAddress>;
  payouts: Map<string, PayoutRecord>;
  listings: Map<string, Listing>;
  photos: Map<string, StoredPhoto>;
  uploads: Map<string, PhotoUpload>;
  reservations: Map<string, Reservation>;
  orders: Map<string, Order>;
  events: OrderEvent[];
  bizum: Map<string, string>;
  shipments: Map<string, Shipment>;
  notifications: Map<string, Notification>;
  // U5
  ledger: LedgerEntryRow[];
  balances: Map<string, ArtistBalance>;
  settlements: Map<string, Settlement>;
  withdrawals: Map<string, Withdrawal>;
  refunds: Map<string, Refund>;
  // U6
  totp: Map<string, TotpState>;
  flags: OrderFlag[];
  notes: OperatorNote[];
  views: Map<string, number>;
  sizes: SizePreset[];
  // U7
  securityEvents: { action: string; at: number }[];
  alertLog: { code: string; bucket: string }[];
  backups: { at: number; sizeBytes: number }[];
  jobStats: {
    failed24h: number;
    pending: number;
    running: number;
    oldestPendingMinutes: number | undefined;
  };
  auditRowsEstimate: number;
  dbDown: boolean;
};

const emptyState = (): MemState => ({
  artists: new Map(),
  addresses: new Map(),
  payouts: new Map(),
  listings: new Map(),
  photos: new Map(),
  uploads: new Map(),
  reservations: new Map(),
  orders: new Map(),
  events: [],
  bizum: new Map(),
  shipments: new Map(),
  notifications: new Map(),
  ledger: [],
  balances: new Map(),
  settlements: new Map(),
  withdrawals: new Map(),
  refunds: new Map(),
  totp: new Map(),
  flags: [],
  notes: [],
  views: new Map(),
  securityEvents: [],
  alertLog: [],
  backups: [],
  jobStats: { failed24h: 0, pending: 0, running: 0, oldestPendingMinutes: undefined },
  auditRowsEstimate: 0,
  dbDown: false,
  sizes: structuredClone([
    { size: 'S', lengthCm: 30, widthCm: 25, heightCm: 5, weightKg: 1, exampleLabel: 'Pequena' },
    { size: 'M', lengthCm: 50, widthCm: 40, heightCm: 10, weightKg: 2, exampleLabel: 'Mediana' },
    { size: 'L', lengthCm: 80, widthCm: 60, heightCm: 10, weightKg: 5, exampleLabel: 'Grande' },
  ] as SizePreset[]),
});

export const DEFAULT_SIZES: SizePreset[] = [
  { size: 'S', lengthCm: 30, widthCm: 25, heightCm: 5, weightKg: 1, exampleLabel: 'Pequena' },
  { size: 'M', lengthCm: 50, widthCm: 40, heightCm: 10, weightKg: 2, exampleLabel: 'Mediana' },
  { size: 'L', lengthCm: 80, widthCm: 60, heightCm: 10, weightKg: 5, exampleLabel: 'Grande' },
];

/**
 * Base de datos en memoria con la misma semantica que Postgres para los repositorios de U2:
 * transacciones serializadas con rollback si la funcion lanza, y filtrado por contexto que imita
 * a las politicas RLS (un artista solo ve lo suyo; el sistema lo ve todo).
 */
export class MemoryDb implements TransactionRunner<AppRepos> {
  state: MemState = emptyState();
  /** Slugs que fuerzan una colision en la siguiente insercion (pruebas de reintento). */
  forcedSlugCollisions: string[] = [];
  /** Hace fallar una vez la operacion indicada (p. ej. 'photos.insertMany') para probar el rollback. */
  failAt: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(deps?: { clock?: Clock; ids?: IdGenerator }) {
    this.clock = deps?.clock ?? systemClock;
    let n = 0;
    this.ids = deps?.ids ?? {
      uuid: () => `00000000-0000-4000-9000-${String((n += 1)).padStart(12, '0')}`,
    };
  }

  run<T>(scope: Scope, fn: (repos: AppRepos) => Promise<T>): Promise<T> {
    const job = this.queue.then(() => this.transaction(scope, fn));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async transaction<T>(scope: Scope, fn: (repos: AppRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await fn(this.repos(scope));
    } catch (cause) {
      this.state = snapshot; // rollback
      throw cause;
    }
  }

  private repos(scope: Scope): AppRepos {
    const base = this.baseRepos(scope);
    const shipping = this.shippingRepos(scope);
    return {
      ...base,
      ...this.ordersRepos(scope, base),
      ...shipping,
      ...this.payoutsRepos(scope, shipping.notifications),
      ...this.operatorRepos(scope),
    };
  }

  private shippingRepos(scope: Scope): ShippingRepos {
    const sees = (artistId: string): boolean =>
      scope.kind === 'system' || scope.artistId === artistId;
    const requireSystem = (): void => {
      if (scope.kind !== 'system') throw new Error('permission denied');
    };
    const ships = this.state.shipments;
    const notes = this.state.notifications;
    const vis = (s: Shipment | undefined): Shipment | undefined =>
      s && sees(s.artistId) ? s : undefined;
    return {
      shipments: {
        insert: (s) => {
          requireSystem();
          if ([...ships.values()].some((x) => x.orderId === s.orderId)) {
            throw new Error('unique violation: un envio por pedido');
          }
          ships.set(s.id, s);
          return Promise.resolve();
        },
        findByOrder: (orderId) =>
          Promise.resolve(vis([...ships.values()].find((s) => s.orderId === orderId))),
        findByOrderForUpdate: (orderId) =>
          Promise.resolve(vis([...ships.values()].find((s) => s.orderId === orderId))),
        findByProviderRefForUpdate: (ref) =>
          Promise.resolve(vis([...ships.values()].find((s) => s.providerRef === ref))),
        save: (s) => {
          requireSystem();
          ships.set(s.id, s);
          return Promise.resolve();
        },
        claimDueForPolling: (now, limit, leaseMs) => {
          requireSystem();
          const due = [...ships.values()]
            .filter(
              (s) =>
                s.nextPollAt !== undefined &&
                s.nextPollAt <= now &&
                s.providerRef !== undefined &&
                s.status !== 'entregado',
            )
            .sort((a, b) => (a.nextPollAt as number) - (b.nextPollAt as number))
            .slice(0, limit);
          for (const s of due) ships.set(s.id, { ...s, nextPollAt: (now + leaseMs) as Instant });
          return Promise.resolve(due);
        },
        listAwaitingPickup: (limit) => {
          requireSystem();
          return Promise.resolve(
            [...ships.values()]
              .filter(
                (s) =>
                  s.status === 'creando' &&
                  s.pickup === undefined &&
                  s.pickupRequestedAt !== undefined,
              )
              .slice(0, limit),
          );
        },
        listDrafts: (limit) => {
          requireSystem();
          return Promise.resolve(
            [...ships.values()]
              .filter((s) => s.status === 'borrador' && s.draftCreatedAt !== undefined)
              .slice(0, limit),
          );
        },
        listLabelPurgeable: (deliveredBefore, createdBefore, limit) => {
          requireSystem();
          return Promise.resolve(
            [...ships.values()]
              .filter(
                (s) =>
                  s.labelKey !== undefined &&
                  ((s.deliveredAt !== undefined && s.deliveredAt < deliveredBefore) ||
                    (s.deliveredAt === undefined && s.createdAt < createdBefore)),
              )
              .slice(0, limit),
          );
        },
      },
      notifications: {
        insertMany: (items) => {
          requireSystem();
          let n = 0;
          for (const x of items) {
            if ([...notes.values()].some((y) => y.orderId === x.orderId && y.type === x.type))
              continue;
            notes.set(x.id, x);
            n += 1;
          }
          return Promise.resolve(n);
        },
        claimDue: (now, limit, leaseMs) => {
          requireSystem();
          const due = [...notes.values()]
            .filter((x) => x.status === 'pendiente' && x.nextAttemptAt <= now)
            .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
            .slice(0, limit);
          for (const x of due) notes.set(x.id, { ...x, nextAttemptAt: (now + leaseMs) as Instant });
          return Promise.resolve(due);
        },
        markSent: (id, now) => {
          const x = notes.get(id);
          if (x) notes.set(id, { ...x, status: 'enviada', sentAt: now, lastError: undefined });
          return Promise.resolve();
        },
        reschedule: (id, attempts, nextAttemptAt, error) => {
          const x = notes.get(id);
          if (x) notes.set(id, { ...x, attempts, nextAttemptAt, lastError: error });
          return Promise.resolve();
        },
        markFailed: (id, attempts, error) => {
          const x = notes.get(id);
          if (x) notes.set(id, { ...x, status: 'fallida', attempts, lastError: error });
          return Promise.resolve();
        },
        listFailedByArtist: (artistId) =>
          Promise.resolve(
            [...notes.values()].filter(
              (x) => x.artistId === artistId && x.status === 'fallida' && sees(x.artistId),
            ),
          ),
        deleteOlderThan: (before) => {
          requireSystem();
          let n = 0;
          for (const x of [...notes.values()]) {
            if (x.createdAt < before) {
              notes.delete(x.id);
              n += 1;
            }
          }
          return Promise.resolve(n);
        },
      },
    };
  }

  /** U6: estado del segundo factor, incidencias, notas, listas y metricas (solo contexto de sistema). */
  private operatorRepos(scope: Scope): OperatorRepos & { readonly manualFlags: ManualFlagReader } {
    const st = this.state;
    const requireSystem = (): void => {
      if (scope.kind !== 'system') throw new Error('permission denied');
    };
    const rowOf = (o: Order): OrderRow => {
      const ship = [...st.shipments.values()].find((x) => x.orderId === o.id);
      const settlement = [...st.settlements.values()].find((x) => x.orderId === o.id);
      const artist = st.artists.get(o.artistId);
      return {
        id: o.id,
        createdAt: o.createdAt,
        status: o.status,
        updatedAt: o.updatedAt,
        artistId: o.artistId,
        artistName: artist?.artisticName ?? 'Sin nombre',
        title: o.snapshot.title,
        totalCents: o.totalCents,
        providerRef: ship?.providerRef,
        shipmentStatus: ship?.status,
        draftCreatedAt: ship?.draftCreatedAt,
        pickupChosen: ship?.pickup !== undefined,
        pickupRequestedAt: ship?.pickupRequestedAt,
        manualFlagOpen: st.flags.some((f) => f.orderId === o.id && f.closedAt === undefined),
        settlementBlocked:
          settlement?.status === 'pendiente' && settlement.blockReason !== undefined,
      };
    };
    const filtered = (
      filter: Parameters<OperatorRepos['operator']['listOrders']>[0],
      now: number,
      staleDays: number,
    ): OrderRow[] =>
      [...st.orders.values()]
        .map(rowOf)
        .filter(
          (r) =>
            (!filter.status || r.status === filter.status) &&
            (!filter.artistId || r.artistId === filter.artistId) &&
            (filter.from === undefined || r.createdAt >= filter.from) &&
            (filter.to === undefined || r.createdAt < filter.to) &&
            (!filter.stuckOnly || stuckReason(r, now, staleDays) !== undefined),
        )
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return {
      manualFlags: {
        hasOpen: (orderId) =>
          Promise.resolve(st.flags.some((f) => f.orderId === orderId && f.closedAt === undefined)),
      },
      operator: {
        listPurgeCandidates: (_now, _months, limit) => {
          requireSystem();
          return Promise.resolve(
            [...st.orders.values()]
              .filter(
                (o) =>
                  o.personalPurgedAt === undefined &&
                  (o.buyer !== undefined || o.destination !== undefined) &&
                  !['pendiente_pago', 'expirado', 'cancelado'].includes(o.status),
              )
              .sort((a, b) => a.createdAt - b.createdAt)
              .slice(0, limit)
              .map((o) => ({ orderId: o.id })),
          );
        },
        securityCounts: (since) => {
          const n = (a: string): number =>
            st.securityEvents.filter((e) => e.action === a && e.at >= since).length;
          return Promise.resolve({
            authFailures: n('auth_failure'),
            authzDenied: n('authz_denied'),
            webhookSignatures: n('webhook_signature_invalid'),
            operatorLocked: n('operator_locked'),
          });
        },
        hasAlertInBucket: (code, bucket) =>
          Promise.resolve(st.alertLog.some((a) => a.code === code && a.bucket === bucket)),
        auditRows: () => Promise.resolve(st.auditRowsEstimate),
        jobStats: () => Promise.resolve(st.jobStats),
        emailStats: () =>
          Promise.resolve({
            pending: [...st.notifications.values()].filter((n) => n.status === 'pendiente').length,
            failed: [...st.notifications.values()].filter((n) => n.status === 'fallida').length,
          }),
        alertStats: () => {
          const m = new Map<string, number>();
          for (const a of st.alertLog) m.set(a.code, (m.get(a.code) ?? 0) + 1);
          return Promise.resolve([...m].map(([code, n]) => ({ code, n })));
        },
        blockedSettlements: () =>
          Promise.resolve(
            [...st.settlements.values()].filter(
              (x) => x.status === 'pendiente' && x.blockReason !== undefined,
            ).length,
          ),
        lastBackup: () => Promise.resolve(st.backups.at(-1)),
        dbPing: () => (st.dbDown ? Promise.reject(new Error('db down')) : Promise.resolve(true)),
        getTotpState: (email) => Promise.resolve(st.totp.get(email)),
        acceptStep: (email, step) => {
          requireSystem();
          const cur = st.totp.get(email);
          if (cur && cur.lastStep >= step) return Promise.resolve(false);
          st.totp.set(email, {
            email,
            lastStep: step,
            failures: cur?.failures ?? 0,
            windowStart: cur?.windowStart,
            lockedUntil: cur?.lockedUntil,
          });
          return Promise.resolve(true);
        },
        recordFailure: (email, now, windowMs, max, lockMs) => {
          requireSystem();
          const cur = st.totp.get(email);
          const fresh = !cur || cur.windowStart === undefined || cur.windowStart < now - windowMs;
          const failures = fresh ? 1 : (cur?.failures ?? 0) + 1;
          const next: TotpState = {
            email,
            lastStep: cur?.lastStep ?? 0,
            failures,
            windowStart: fresh ? now : cur?.windowStart,
            lockedUntil: failures >= max ? now + lockMs : cur?.lockedUntil,
          };
          st.totp.set(email, next);
          return Promise.resolve(next);
        },
        resetFailures: (email) => {
          const cur = st.totp.get(email);
          if (cur) {
            st.totp.set(email, {
              ...cur,
              failures: 0,
              windowStart: undefined,
              lockedUntil: undefined,
            });
          }
          return Promise.resolve();
        },
        findOpenFlag: (orderId) =>
          Promise.resolve(st.flags.find((f) => f.orderId === orderId && f.closedAt === undefined)),
        listFlags: (orderId) => Promise.resolve(st.flags.filter((f) => f.orderId === orderId)),
        openFlag: (flag) => {
          requireSystem();
          if (st.flags.some((f) => f.orderId === flag.orderId && f.closedAt === undefined)) {
            return Promise.resolve(false);
          }
          st.flags.push(flag);
          return Promise.resolve(true);
        },
        closeFlag: (id, closedBy, resolution, now) => {
          const i = st.flags.findIndex((f) => f.id === id && f.closedAt === undefined);
          if (i < 0) return Promise.resolve(false);
          st.flags[i] = { ...(st.flags[i] as OrderFlag), closedBy, resolution, closedAt: now };
          return Promise.resolve(true);
        },
        addNote: (note) => {
          requireSystem();
          if (note.formKey && st.notes.some((n) => n.formKey === note.formKey)) {
            return Promise.resolve(false);
          }
          st.notes.push(note);
          return Promise.resolve(true);
        },
        listNotes: (orderId) =>
          Promise.resolve(st.notes.filter((n) => n.orderId === orderId).reverse()),
        listOrders: (filter, limit, offset, now, staleDays) => {
          requireSystem();
          const all = filtered(filter, now, staleDays);
          return Promise.resolve({ rows: all.slice(offset, offset + limit), total: all.length });
        },
        listDrafts: (limit) => {
          requireSystem();
          return Promise.resolve(
            [...st.shipments.values()]
              .filter((x) => x.status === 'borrador' && x.draftCreatedAt !== undefined)
              .sort((a, b) => (a.draftCreatedAt as number) - (b.draftCreatedAt as number))
              .slice(0, limit)
              .map((x) => ({
                orderId: x.orderId,
                providerRef: x.providerRef,
                draftCreatedAt: x.draftCreatedAt as number,
                title: st.orders.get(x.orderId)?.snapshot.title ?? '',
              })),
          );
        },
        counts: (now, staleDays) => {
          requireSystem();
          return Promise.resolve({
            stuck: filtered({ stuckOnly: true }, now, staleDays).length,
            unpaidDrafts: [...st.shipments.values()].filter((x) => x.status === 'borrador').length,
            openFlags: st.flags.filter((f) => f.closedAt === undefined).length,
          });
        },
        listArtists: () =>
          Promise.resolve(
            [...st.artists.values()].map((a) => ({
              id: a.id,
              name: a.artisticName ?? 'Sin nombre',
            })),
          ),
        saveSize: (size, v) => {
          requireSystem();
          const i = st.sizes.findIndex((x) => x.size === size);
          if (i < 0) return Promise.resolve(false);
          st.sizes[i] = { ...(st.sizes[i] as SizePreset), ...v };
          return Promise.resolve(true);
        },
        addView: (slug, day) => {
          requireSystem();
          const listing = [...st.listings.values()].find((l) => l.slug === slug.toLowerCase());
          if (!listing) return Promise.resolve(false);
          const key = `${listing.id}|${day}`;
          st.views.set(key, (st.views.get(key) ?? 0) + 1);
          return Promise.resolve(true);
        },
        purgeViews: (beforeDay) => {
          requireSystem();
          let n = 0;
          for (const key of [...st.views.keys()]) {
            if ((key.split('|')[1] ?? '') < beforeDay) {
              st.views.delete(key);
              n += 1;
            }
          }
          return Promise.resolve(n);
        },
        rawMetrics: (from, to) => {
          requireSystem();
          const paidIds = new Set(
            st.events
              .filter(
                (e) =>
                  (e.kind === 'pago_confirmado' || e.kind === 'cobro_manual_confirmado') &&
                  e.at >= from &&
                  e.at < to,
              )
              .map((e) => e.orderId),
          );
          const orders = [...st.orders.values()].filter((o) => paidIds.has(o.id));
          const withCost = orders.filter((o) => o.labelCostCents !== undefined);
          const byArtist = new Map<string, number>();
          for (const o of orders) byArtist.set(o.artistId, (byArtist.get(o.artistId) ?? 0) + 1);
          let views = 0;
          for (const [key, n] of st.views) {
            const day = Date.parse(`${key.split('|')[1]}T00:00:00Z`);
            if (
              day >=
                Date.UTC(
                  new Date(from).getUTCFullYear(),
                  new Date(from).getUTCMonth(),
                  new Date(from).getUTCDate(),
                ) &&
              day <
                Date.UTC(
                  new Date(to).getUTCFullYear(),
                  new Date(to).getUTCMonth(),
                  new Date(to).getUTCDate(),
                )
            ) {
              views += n;
            }
          }
          const timing = [...paidIds].flatMap((id) => {
            const pay = st.events.find((e) => e.orderId === id && e.kind === 'pago_confirmado');
            const label = st.events.find((e) => e.orderId === id && e.kind === 'etiqueta_lista');
            return pay && label && label.at >= pay.at ? [label.at - pay.at] : [];
          });
          return Promise.resolve({
            listingsCreated: [...st.listings.values()].filter(
              (l) => l.createdAt >= from && l.createdAt < to,
            ).length,
            views,
            paidOrders: orders.length,
            cardOrders: orders.filter((o) => o.paymentMethod === 'tarjeta').length,
            bizumOrders: orders.filter((o) => o.paymentMethod === 'bizum').length,
            puntoOrders: orders.filter((o) => o.effectiveModality === 'punto').length,
            recogidaOrders: orders.filter((o) => o.effectiveModality === 'recogida').length,
            shippingChargedCents: orders.reduce((a, o) => a + o.shippingCents, 0),
            labelCostCents: withCost.reduce((a, o) => a + (o.labelCostCents ?? 0), 0),
            ordersWithLabelCost: withCost.length,
            payToLabelMsTotal: timing.reduce((a, b) => a + b, 0),
            payToLabelCount: timing.length,
            incidents:
              new Set(
                st.events
                  .filter(
                    (e) =>
                      (e.kind === 'incidencia_envio' || e.kind === 'doble_pago_detectado') &&
                      e.at >= from &&
                      e.at < to,
                  )
                  .map((e) => e.orderId),
              ).size + st.flags.filter((f) => f.openedAt >= from && f.openedAt < to).length,
            artistsWithOrders: byArtist.size,
            repeatArtists: [...byArtist.values()].filter((n) => n >= 2).length,
          });
        },
      },
    };
  }

  /** U5: libro, saldos, liquidaciones, retiradas y reembolsos con la semantica de la base real. */
  private payoutsRepos(
    scope: Scope,
    notifications: PayoutsRepos['notifications'],
  ): Pick<
    PayoutsRepos,
    'ledger' | 'balances' | 'settlements' | 'withdrawals' | 'refunds' | 'payoutAccounts'
  > & { readonly notifications: PayoutsRepos['notifications'] } {
    const st = this.state;
    const sees = (artistId: string | undefined): boolean =>
      scope.kind === 'system' || (artistId !== undefined && scope.artistId === artistId);
    const requireSystem = (): void => {
      if (scope.kind !== 'system') throw new Error('permission denied');
    };
    const bal = (artistId: string): ArtistBalance =>
      st.balances.get(artistId) ?? {
        artistId,
        retainedCents: 0,
        availableCents: 0,
        withdrawalCount: 0,
      };
    return {
      notifications,
      ledger: {
        insertMany: (entries, now) => {
          requireSystem();
          const inserted: string[] = [];
          for (const e of entries) {
            if (e.deltaCents === 0) throw new Error('check violation: delta distinto de cero');
            const dup = st.ledger.some(
              (x) =>
                x.entryKey === e.entryKey ||
                (e.orderId !== undefined &&
                  x.orderId === e.orderId &&
                  ((['cobro', 'retencion', 'envio_plataforma', 'comision'].includes(e.kind) &&
                    x.kind === e.kind) ||
                    (e.kind === 'liquidacion' && x.kind === e.kind && x.bucket === e.bucket))),
            );
            if (dup) continue;
            st.ledger.push({ ...e, at: now });
            inserted.push(e.entryKey);
          }
          return Promise.resolve(inserted);
        },
        listByOrder: (orderId) =>
          Promise.resolve(
            st.ledger.filter(
              (x) =>
                x.orderId === orderId && (scope.kind === 'system' || x.artistId === scope.artistId),
            ),
          ),
        listByArtist: (artistId, limit) =>
          Promise.resolve(
            st.ledger
              .filter(
                (x) =>
                  x.artistId === artistId &&
                  sees(artistId) &&
                  (x.bucket === 'retenido' || x.bucket === 'disponible'),
              )
              .slice(-limit)
              .reverse(),
          ),
        sumsByArtist: () => {
          requireSystem();
          const sums = new Map<string, { retained: number; available: number }>();
          for (const x of st.ledger) {
            if (x.artistId === undefined) continue;
            const cur = sums.get(x.artistId) ?? { retained: 0, available: 0 };
            if (x.bucket === 'retenido') cur.retained += x.deltaCents;
            if (x.bucket === 'disponible') cur.available += x.deltaCents;
            sums.set(x.artistId, cur);
          }
          return Promise.resolve(
            [...sums].map(([artistId, v]) => ({
              artistId,
              retainedCents: v.retained,
              availableCents: v.available,
            })),
          );
        },
        orderGaps: () => {
          requireSystem();
          const gaps = new Map<string, number>();
          for (const x of st.ledger) {
            if (x.orderId === undefined) continue;
            gaps.set(
              x.orderId,
              (gaps.get(x.orderId) ?? 0) + (x.bucket === 'stripe' ? x.deltaCents : -x.deltaCents),
            );
          }
          return Promise.resolve(
            [...gaps]
              .filter(([, g]) => g !== 0)
              .map(([orderId, gapCents]) => ({ orderId, gapCents })),
          );
        },
        listBetween: (from, to) => {
          requireSystem();
          return Promise.resolve(st.ledger.filter((x) => x.at >= from && x.at < to));
        },
      },
      balances: {
        lock: (artistId) => {
          requireSystem();
          const b = bal(artistId);
          st.balances.set(artistId, b);
          return Promise.resolve(b);
        },
        find: (artistId) => Promise.resolve(sees(artistId) ? st.balances.get(artistId) : undefined),
        save: (b) => {
          requireSystem();
          if (b.retainedCents < 0 || b.availableCents < 0) {
            throw new Error('check violation: saldo negativo');
          }
          st.balances.set(b.artistId, b);
          return Promise.resolve();
        },
        listAll: () => {
          requireSystem();
          return Promise.resolve([...st.balances.values()]);
        },
      },
      settlements: {
        insertIfAbsent: (s) => {
          requireSystem();
          if ([...st.settlements.values()].some((x) => x.orderId === s.orderId)) {
            return Promise.resolve(false);
          }
          st.settlements.set(s.id, s);
          return Promise.resolve(true);
        },
        findByOrder: (orderId) =>
          Promise.resolve(
            [...st.settlements.values()].find((x) => x.orderId === orderId && sees(x.artistId)),
          ),
        findByOrderForUpdate: (orderId) =>
          Promise.resolve([...st.settlements.values()].find((x) => x.orderId === orderId)),
        save: (s) => {
          requireSystem();
          st.settlements.set(s.id, s);
          return Promise.resolve();
        },
        claimDue: (now, limit, leaseMs) => {
          requireSystem();
          const due = [...st.settlements.values()]
            .filter((x) => x.status === 'pendiente' && x.nextAttemptAt <= now)
            .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
            .slice(0, limit);
          for (const x of due) {
            st.settlements.set(x.id, { ...x, nextAttemptAt: (now + leaseMs) as Instant });
          }
          return Promise.resolve(due);
        },
        listByArtist: (artistId, limit) =>
          Promise.resolve(
            [...st.settlements.values()]
              .filter((x) => x.artistId === artistId && sees(artistId))
              .slice(0, limit),
          ),
        listBetween: (from, to) => {
          requireSystem();
          return Promise.resolve(
            [...st.settlements.values()].filter((x) => x.createdAt >= from && x.createdAt < to),
          );
        },
        listBlockedUnalerted: (before, limit) => {
          requireSystem();
          return Promise.resolve(
            [...st.settlements.values()]
              .filter(
                (x) =>
                  x.status === 'pendiente' && x.alertedAt === undefined && x.createdAt <= before,
              )
              .slice(0, limit),
          );
        },
      },
      withdrawals: {
        insert: (w) => {
          if (scope.kind !== 'system' && !sees(w.artistId)) throw new Error('permission denied');
          const all = [...st.withdrawals.values()];
          if (
            all.some(
              (x) =>
                x.idempotencyKey === w.idempotencyKey ||
                (x.artistId === w.artistId && x.seq === w.seq),
            )
          ) {
            throw new Error('unique violation: retirada repetida');
          }
          st.withdrawals.set(w.id, w);
          return Promise.resolve();
        },
        findOpenByArtist: (artistId) =>
          Promise.resolve(
            [...st.withdrawals.values()].find(
              (x) => x.artistId === artistId && x.status === 'solicitada' && sees(artistId),
            ),
          ),
        findByIdForUpdate: (id) => Promise.resolve(st.withdrawals.get(id)),
        save: (w) => {
          requireSystem();
          st.withdrawals.set(w.id, w);
          return Promise.resolve();
        },
        listByArtist: (artistId, limit) =>
          Promise.resolve(
            [...st.withdrawals.values()]
              .filter((x) => x.artistId === artistId && sees(artistId))
              .reverse()
              .slice(0, limit),
          ),
        listBetween: (from, to) => {
          requireSystem();
          return Promise.resolve(
            [...st.withdrawals.values()].filter((x) => x.createdAt >= from && x.createdAt < to),
          );
        },
        claimOpenDue: (now, limit, leaseMs) => {
          requireSystem();
          const due = [...st.withdrawals.values()]
            .filter(
              (x) =>
                x.status === 'solicitada' &&
                x.nextAttemptAt !== undefined &&
                x.nextAttemptAt <= now,
            )
            .slice(0, limit);
          for (const x of due) {
            st.withdrawals.set(x.id, { ...x, nextAttemptAt: (now + leaseMs) as Instant });
          }
          return Promise.resolve(due);
        },
      },
      refunds: {
        insert: (r) => {
          requireSystem();
          if ([...st.refunds.values()].some((x) => x.orderId === r.orderId && x.seq === r.seq)) {
            throw new Error('unique violation: reembolso repetido');
          }
          st.refunds.set(r.id, r);
          return Promise.resolve();
        },
        listByOrder: (orderId) => {
          const order = st.orders.get(orderId);
          if (!order || !sees(order.artistId)) return Promise.resolve([]);
          return Promise.resolve(
            [...st.refunds.values()]
              .filter((x) => x.orderId === orderId)
              .sort((a, b) => a.seq - b.seq),
          );
        },
        findByIdForUpdate: (id) => Promise.resolve(st.refunds.get(id)),
        save: (r) => {
          requireSystem();
          st.refunds.set(r.id, r);
          return Promise.resolve();
        },
        listBetween: (from, to) => {
          requireSystem();
          return Promise.resolve(
            [...st.refunds.values()].filter((x) => x.createdAt >= from && x.createdAt < to),
          );
        },
      },
      payoutAccounts: {
        find: (artistId) => {
          const payout = st.payouts.get(artistId);
          return Promise.resolve(
            payout
              ? {
                  providerAccountId: payout.providerAccountId,
                  active: payout.state.status === 'activo',
                }
              : undefined,
          );
        },
      },
    };
  }

  private ordersRepos(scope: Scope, base: AccountsRepos & ListingsRepos): OrdersRepos {
    const sees = (artistId: string): boolean =>
      scope.kind === 'system' || scope.artistId === artistId;
    const requireSystem = (): void => {
      if (scope.kind !== 'system') throw new Error('permission denied');
    };
    const orders = this.state.orders;
    const paidLike = (o: Order): boolean =>
      !['pendiente_pago', 'expirado', 'cancelado', 'incidencia', 'reembolsado'].includes(o.status);
    const vis = (o: Order | undefined): Order | undefined =>
      o && sees(o.artistId) ? o : undefined;
    const find = (pred: (o: Order) => boolean): Order | undefined =>
      vis([...orders.values()].find(pred));
    return {
      orders: {
        insert: (o) => {
          requireSystem();
          const all = [...orders.values()];
          if (all.some((x) => x.submissionKey === o.submissionKey)) {
            throw new SubmissionKeyTakenError();
          }
          if (all.some((x) => x.trackingHash === o.trackingHash))
            throw new Error('unique violation');
          orders.set(o.id, o);
          return Promise.resolve();
        },
        findById: (id) => Promise.resolve(vis(orders.get(id))),
        findByIdForUpdate: (id) => Promise.resolve(vis(orders.get(id))),
        findBySubmissionKey: (k) => Promise.resolve(find((o) => o.submissionKey === k)),
        findByCheckoutSession: (id) => Promise.resolve(find((o) => o.checkoutSessionId === id)),
        findByTrackingHash: (h) => Promise.resolve(find((o) => o.trackingHash === h)),
        findByResumeHash: (h) => Promise.resolve(find((o) => o.resumeHash === h)),
        save: (o) => {
          requireSystem();
          const current = orders.get(o.id);
          if (!current || current.version !== o.version - 1) return Promise.resolve(false);
          if (
            paidLike(o) &&
            [...orders.values()].some(
              (x) => x.id !== o.id && x.listingId === o.listingId && paidLike(x),
            )
          ) {
            throw new Error('unique violation: un pedido pagado por enlace');
          }
          orders.set(o.id, o);
          return Promise.resolve(true);
        },
        listByArtist: (artistId, limit) =>
          Promise.resolve(
            [...orders.values()]
              .filter((o) => o.artistId === artistId && sees(o.artistId))
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, limit),
          ),
        listOverdue: (now, limit) => {
          requireSystem();
          return Promise.resolve(
            [...orders.values()]
              .filter((o) => o.status === 'pendiente_pago' && o.expiresAt <= now - SWEEP_GRACE_MS)
              .sort((a, b) => a.expiresAt - b.expiresAt)
              .slice(0, limit),
          );
        },
        listPurgeable: (before, limit) => {
          requireSystem();
          return Promise.resolve(
            [...orders.values()]
              .filter(
                (o) =>
                  (o.status === 'expirado' || o.status === 'cancelado') &&
                  o.personalPurgedAt === undefined &&
                  o.updatedAt < before,
              )
              .slice(0, limit),
          );
        },
        findByPaymentIntent: (pi) => Promise.resolve(find((o) => o.paymentIntentId === pi)),
        listStaleInTransit: (before, limit) => {
          requireSystem();
          return Promise.resolve(
            [...orders.values()]
              .filter((o) => o.status === 'en_transito' && o.updatedAt <= before)
              .slice(0, limit),
          );
        },
        listPaidBetween: (from, to, limit) => {
          requireSystem();
          return Promise.resolve(
            [...orders.values()]
              .filter(
                (o) =>
                  o.paymentMode === 'stripe' &&
                  o.createdAt >= from &&
                  o.createdAt < to &&
                  paidLike(o),
              )
              .slice(0, limit),
          );
        },
        listStripeSince: (since, limit) => {
          requireSystem();
          return Promise.resolve(
            [...orders.values()]
              .filter((o) => o.paymentMode === 'stripe' && o.createdAt >= since)
              .slice(0, limit),
          );
        },
      },
      orderEvents: {
        append: (e) => {
          requireSystem();
          this.state.events.push(e);
          return Promise.resolve();
        },
        listByOrder: (orderId) =>
          Promise.resolve(
            this.state.events.filter((e) => e.orderId === orderId && sees(e.artistId)),
          ),
      },
      contacts: {
        findBizumPhone: (artistId) => Promise.resolve(this.state.bizum.get(artistId)),
        findEmail: (artistId) => Promise.resolve(this.state.artists.get(artistId)?.email),
        saveBizumPhone: (artistId, phone) => {
          if (phone === undefined) this.state.bizum.delete(artistId);
          else this.state.bizum.set(artistId, phone);
          return Promise.resolve();
        },
      },
      sales: createListingSales(base, this.clock, this.ids),
    };
  }

  private baseRepos(scope: Scope): AccountsRepos & ListingsRepos {
    const sees = (artistId: string): boolean =>
      scope.kind === 'system' || scope.artistId === artistId;
    const requireSystem = (): void => {
      if (scope.kind !== 'system') throw new Error('permission denied');
    };

    return {
      artists: {
        findById: (id) => Promise.resolve(sees(id) ? this.state.artists.get(id) : undefined),
        upsertOnSignIn: (id, email: Email, now: Instant) => {
          const existing = this.state.artists.get(id);
          const artist: Artist = existing
            ? { ...existing, email, updatedAt: now }
            : {
                id,
                email,
                artisticName: undefined,
                instagram: undefined,
                phone: undefined,
                createdAt: now,
                updatedAt: now,
              };
          this.state.artists.set(id, artist);
          return Promise.resolve(artist);
        },
        saveProfile: (id, profile: ProfileInput, now) => {
          const current = this.state.artists.get(id);
          if (!current || !sees(id)) throw new Error('not found');
          const next: Artist = {
            ...current,
            artisticName: profile.artisticName,
            instagram: profile.instagram as InstagramHandle,
            phone: profile.phone,
            updatedAt: now,
          };
          this.state.artists.set(id, next);
          return Promise.resolve(next);
        },
      },
      addresses: {
        find: (artistId) =>
          Promise.resolve(sees(artistId) ? this.state.addresses.get(artistId) : undefined),
        save: (artistId, a: AddressInput) => {
          const next: SenderAddress = {
            artistId,
            street: a.street,
            number: a.number,
            floorDoor: a.floorDoor,
            postalCode: a.postalCode as PeninsularPostalCode,
            city: a.city,
            province: a.province,
            phone: a.phone,
            country: 'ES',
          };
          this.state.addresses.set(artistId, next);
          return Promise.resolve(next);
        },
      },
      payouts: {
        find: (artistId) =>
          Promise.resolve(sees(artistId) ? this.state.payouts.get(artistId) : undefined),
        findByProviderAccountId: (id) => {
          requireSystem();
          return Promise.resolve(
            [...this.state.payouts.values()].find((p) => p.providerAccountId === id),
          );
        },
        lockForUpdate: (artistId) => {
          let record = this.state.payouts.get(artistId);
          if (!record) {
            record = { artistId, providerAccountId: undefined, state: { status: 'sin_iniciar' } };
            this.state.payouts.set(artistId, record);
          }
          return Promise.resolve(record);
        },
        setProviderAccount: (artistId, providerAccountId) => {
          const record = this.state.payouts.get(artistId);
          if (record) this.state.payouts.set(artistId, { ...record, providerAccountId });
          return Promise.resolve();
        },
        saveState: (artistId, state: PayoutState) => {
          const record = this.state.payouts.get(artistId);
          if (record) this.state.payouts.set(artistId, { ...record, state });
          return Promise.resolve();
        },
      },
      listings: {
        insert: (artistId, id, slug: Slug, draft: ListingDraft, now) => {
          const forced = this.forcedSlugCollisions.shift();
          const taken =
            forced === slug || [...this.state.listings.values()].some((l) => l.slug === slug);
          if (taken) throw new SlugTakenError();
          const listing: Listing = {
            id,
            artistId,
            slug,
            ...draft,
            status: 'activo',
            pausedReason: undefined,
            orderId: undefined,
            createdAt: now,
            updatedAt: now,
            soldAt: undefined,
          };
          this.state.listings.set(id, listing);
          return Promise.resolve(listing);
        },
        findById: (id) => {
          const l = this.state.listings.get(id);
          return Promise.resolve(l && sees(l.artistId) ? l : undefined);
        },
        findByIdForUpdate: (id) => {
          const l = this.state.listings.get(id);
          return Promise.resolve(l && sees(l.artistId) ? l : undefined);
        },
        findBySlug: (slug) => {
          const l = [...this.state.listings.values()].find((x) => x.slug === slug);
          return Promise.resolve(l && sees(l.artistId) ? l : undefined);
        },
        listByArtist: (artistId) =>
          Promise.resolve(
            sees(artistId)
              ? [...this.state.listings.values()].filter((l) => l.artistId === artistId)
              : [],
          ),
        countOpen: (artistId) =>
          Promise.resolve(
            [...this.state.listings.values()].filter(
              (l) => l.artistId === artistId && countsTowardLimit(l.status),
            ).length,
          ),
        save: (l) => {
          if (this.state.listings.has(l.id) && sees(l.artistId)) this.state.listings.set(l.id, l);
          return Promise.resolve();
        },
        pauseActiveForRestriction: (artistId, now) => {
          let n = 0;
          for (const l of this.state.listings.values()) {
            if (l.artistId === artistId && l.status === 'activo') {
              this.state.listings.set(l.id, {
                ...l,
                status: 'pausado',
                pausedReason: 'cobros_restringidos',
                updatedAt: now,
              });
              n += 1;
            }
          }
          return Promise.resolve(n);
        },
      },
      photos: {
        insertMany: (photos) => {
          if (this.failAt === 'photos.insertMany') {
            this.failAt = undefined;
            throw new Error('fallo simulado');
          }
          for (const p of photos) this.state.photos.set(p.id, p);
          return Promise.resolve();
        },
        listByListing: (listingId) =>
          Promise.resolve(
            [...this.state.photos.values()]
              .filter((p) => p.listingId === listingId && sees(p.artistId))
              .sort((a, b) => a.position - b.position),
          ),
        listByListings: (ids) =>
          Promise.resolve(
            [...this.state.photos.values()].filter(
              (p) => ids.includes(p.listingId) && sees(p.artistId),
            ),
          ),
        remove: (id) => {
          this.state.photos.delete(id);
          return Promise.resolve();
        },
        renumber: (_listingId, orderedIds) => {
          orderedIds.forEach((id, index) => {
            const p = this.state.photos.get(id);
            if (p) this.state.photos.set(id, { ...p, position: index + 1 });
          });
          return Promise.resolve();
        },
      },
      uploads: {
        insert: (u) => {
          this.state.uploads.set(u.id, u);
          return Promise.resolve();
        },
        findPending: (artistId, ids, now) =>
          Promise.resolve(
            [...this.state.uploads.values()].filter(
              (u) =>
                u.artistId === artistId &&
                sees(artistId) &&
                ids.includes(u.id) &&
                u.status === 'pendiente' &&
                u.expiresAt > now,
            ),
          ),
        markConsumed: (ids) => {
          for (const id of ids) {
            const u = this.state.uploads.get(id);
            if (u) this.state.uploads.set(id, { ...u, status: 'consumida' });
          }
          return Promise.resolve();
        },
        findExpired: (now, limit) => {
          requireSystem();
          return Promise.resolve(
            [...this.state.uploads.values()]
              .filter((u) => u.status === 'pendiente' && u.expiresAt <= now)
              .slice(0, limit),
          );
        },
        delete: (ids) => {
          for (const id of ids) this.state.uploads.delete(id);
          return Promise.resolve();
        },
      },
      reservations: {
        expireDue: (listingId, now) => {
          for (const r of this.state.reservations.values()) {
            if (r.listingId === listingId && r.status === 'activa' && r.expiresAt <= now) {
              this.state.reservations.set(r.id, { ...r, status: 'expirada' });
            }
          }
          return Promise.resolve();
        },
        findActive: (listingId, now) =>
          Promise.resolve(
            [...this.state.reservations.values()].find(
              (r) =>
                r.listingId === listingId &&
                r.status === 'activa' &&
                r.expiresAt > now &&
                sees(r.artistId),
            ),
          ),
        findById: (id) => {
          const r = this.state.reservations.get(id);
          return Promise.resolve(r && sees(r.artistId) ? r : undefined);
        },
        insert: (r) => {
          requireSystem();
          const clash = [...this.state.reservations.values()].some(
            (x) => x.listingId === r.listingId && x.status === 'activa',
          );
          if (clash) throw new Error('unique violation: una reserva activa por enlace');
          this.state.reservations.set(r.id, r);
          return Promise.resolve();
        },
        update: (r) => {
          requireSystem();
          this.state.reservations.set(r.id, r);
          return Promise.resolve();
        },
      },
      sizes: { list: () => Promise.resolve(this.state.sizes) },
      publicArtists: {
        find: (artistId): Promise<PublicArtist | undefined> => {
          const a = this.state.artists.get(artistId);
          return Promise.resolve(
            a?.artisticName && a.instagram
              ? { artisticName: a.artisticName, instagram: a.instagram }
              : undefined,
          );
        },
      },
      eligibility: {
        get: (artistId): Promise<ArtistEligibility> => {
          const a = this.state.artists.get(artistId);
          return Promise.resolve({
            profileComplete: Boolean(a?.artisticName && a.instagram && a.phone),
            hasAddress: this.state.addresses.has(artistId),
            payoutStatus: this.state.payouts.get(artistId)?.state.status ?? 'sin_iniciar',
          });
        },
      },
      locks: { lock: () => Promise.resolve() },
    };
  }
}
