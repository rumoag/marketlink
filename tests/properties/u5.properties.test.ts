import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { instantOf, MS } from '@/modules/kernel/domain/clock';
import {
  applyEntries,
  balanceOf,
  conservationGap,
  EMPTY_BALANCE,
  planPayment,
  planRefundEntries,
  planSettlementEntries,
  planWithdrawalEntry,
  planWithdrawalReversal,
  splitRefund,
  type LedgerEntry,
} from '@/modules/ledger/domain/ledger';
import { applyTrigger, ORDER_STATUSES, type OrderStatus } from '@/modules/orders/domain/order';
import {
  canRelease,
  isRecentLogin,
  planRefund,
  planSettlement,
  planWithdrawal,
  refundKey,
  settlementAmount,
  settlementKey,
  staleDelivery,
  withdrawalKey,
} from '@/modules/payouts/domain/payouts';
import { renderFinanceCsv, csvCell, buildMarginReport } from '@/modules/payouts/domain/reports';
import type { Order } from '@/modules/orders/domain/order';

const work = fc.integer({ min: 100, max: 100_000 });
const ship = fc.integer({ min: 1, max: 10_000 });
const id = fc.uuid();
const NOW = instantOf(Date.UTC(2026, 10, 7, 10));

const pay = (w: number, s: number, c = 0) => {
  const r = planPayment({
    orderId: 'o1',
    artistId: 'a1',
    workCents: w,
    shippingCents: s,
    commissionCents: c,
  });
  if (!r.ok) throw new Error('plan');
  return r.value;
};

describe('P-U5-01 reparto del reembolso', () => {
  it('shipping + artista = R, el envio va primero y nada es negativo', () => {
    fc.assert(
      fc.property(
        ship,
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 110_000 }),
        (e, done, r) => {
          const split = splitRefund({
            requestCents: r,
            shippingCents: e,
            refundedShippingCents: Math.min(done, e),
          });
          expect(split.shippingPartCents + split.artistPartCents).toBe(r);
          expect(split.shippingPartCents).toBeGreaterThanOrEqual(0);
          expect(split.artistPartCents).toBeGreaterThanOrEqual(0);
          expect(split.shippingPartCents).toBeLessThanOrEqual(e - Math.min(done, e));
          if (split.artistPartCents > 0) {
            expect(split.shippingPartCents).toBe(e - Math.min(done, e));
          }
        },
      ),
    );
  });
});

describe('P-U5-02 y P-U5-03 reembolsos acumulados', () => {
  it('la suma de reembolsos aceptados nunca supera el total y lo reembolsado de la artista nunca supera la obra', () => {
    fc.assert(
      fc.property(
        work,
        ship,
        fc.array(fc.integer({ min: 1, max: 60_000 }), { maxLength: 8 }),
        (w, e, reqs) => {
          let refunded = 0;
          let refShip = 0;
          let refArtist = 0;
          for (const r of reqs) {
            const plan = planRefund({
              orderStatus: 'pagado',
              totalCents: w + e,
              shippingCents: e,
              refundedCents: refunded,
              refundedShippingCents: refShip,
              requestCents: r,
            });
            if (!plan.ok) {
              expect(plan.error).toBe('exceeds_remaining');
              expect(r).toBeGreaterThan(w + e - refunded);
              continue;
            }
            refunded += r;
            refShip += plan.value.shippingPartCents;
            refArtist += plan.value.artistPartCents;
            expect(plan.value.isTotal).toBe(refunded === w + e);
          }
          expect(refunded).toBeLessThanOrEqual(w + e);
          expect(refShip).toBeLessThanOrEqual(e);
          expect(refArtist).toBeLessThanOrEqual(w);
        },
      ),
    );
  });

  it('tras liquidar no se reembolsa', () => {
    fc.assert(
      fc.property(work, ship, (w, e) => {
        const r = planRefund({
          orderStatus: 'liquidado',
          totalCents: w + e,
          shippingCents: e,
          refundedCents: 0,
          refundedShippingCents: 0,
          requestCents: 1,
        });
        expect(r).toEqual({ ok: false, error: 'already_settled' });
      }),
    );
  });
});

/** Modelo de referencia: aplica una secuencia de operaciones y comprueba los invariantes en cada paso. */
type Op =
  { t: 'pay' } | { t: 'settle' } | { t: 'withdraw' } | { t: 'refund'; r: number } | { t: 'fail' };

describe('P-U5-04 y P-U5-05 conservacion y saldo derivado', () => {
  it('con cualquier secuencia valida de operaciones el dinero se conserva y los saldos nunca son negativos', () => {
    const ops = fc.array(
      fc.oneof(
        fc.constant<Op>({ t: 'pay' }),
        fc.constant<Op>({ t: 'settle' }),
        fc.constant<Op>({ t: 'withdraw' }),
        fc.constant<Op>({ t: 'fail' }),
        fc.integer({ min: 1, max: 120_000 }).map<Op>((r) => ({ t: 'refund', r })),
      ),
      { maxLength: 14 },
    );
    fc.assert(
      fc.property(work, ship, ops, (w, e, seq) => {
        const log: LedgerEntry[] = [];
        let balance = EMPTY_BALANCE;
        let paid = false;
        let settled = false;
        let refunded = 0;
        let refShip = 0;
        let refArtist = 0;
        let seqNo = 0;
        let lastWithdrawal: { seq: number; amount: number } | undefined;
        const post = (entries: readonly LedgerEntry[]): void => {
          const next = applyEntries(
            balance,
            entries.filter((x) => x.artistId !== undefined),
          );
          if (!next.ok) throw new Error('saldo negativo permitido');
          balance = next.value;
          log.push(...entries);
        };
        for (const op of seq) {
          if (op.t === 'pay' && !paid) {
            paid = true;
            post(pay(w, e));
          } else if (op.t === 'settle' && paid && !settled) {
            const amount = settlementAmount(w, 0, refArtist);
            if (amount > 0) {
              settled = true;
              const r = planSettlementEntries({
                orderId: 'o1',
                artistId: 'a1',
                amountCents: amount,
                reasonCode: 'x',
              });
              if (r.ok) post(r.value);
            }
          } else if (op.t === 'withdraw' && balance.availableCents > 0) {
            seqNo += 1;
            const r = planWithdrawalEntry({
              artistId: 'a1',
              seq: seqNo,
              amountCents: balance.availableCents,
            });
            if (r.ok) {
              lastWithdrawal = { seq: seqNo, amount: balance.availableCents };
              post([r.value]);
            }
          } else if (op.t === 'fail' && lastWithdrawal) {
            const r = planWithdrawalReversal({
              artistId: 'a1',
              seq: lastWithdrawal.seq,
              amountCents: lastWithdrawal.amount,
            });
            if (r.ok) post([r.value]);
            lastWithdrawal = undefined;
          } else if (op.t === 'refund' && paid && !settled) {
            const plan = planRefund({
              orderStatus: 'pagado',
              totalCents: w + e,
              shippingCents: e,
              refundedCents: refunded,
              refundedShippingCents: refShip,
              requestCents: op.r,
            });
            if (plan.ok) {
              const entries = planRefundEntries({
                orderId: 'o1',
                artistId: 'a1',
                seq: refunded + 1,
                split: plan.value,
              });
              if (entries.ok) {
                post(entries.value);
                refunded += op.r;
                refShip += plan.value.shippingPartCents;
                refArtist += plan.value.artistPartCents;
              }
            }
          }
          // P-U5-05: el saldo incremental coincide con el derivado del libro.
          const derived = balanceOf(log.filter((x) => x.artistId !== undefined));
          expect(derived).toEqual({ ok: true, value: balance });
          // P-U5-04: el dinero cobrado se reparte entre cubos y retiradas sin perder un centimo.
          expect(conservationGap(log)).toBe(0);
        }
      }),
    );
  });
});

describe('P-U5-06 a P-U5-08 liquidacion', () => {
  const base = (over: Partial<Parameters<typeof planSettlement>[0]> = {}) => ({
    orderStatus: 'entregado' as OrderStatus,
    workCents: 10_000,
    commissionCents: 0,
    refundedArtistCents: 0,
    deliveredAt: NOW,
    now: NOW,
    delayHours: 0,
    accountActive: true,
    hasCharge: true,
    shipmentIncident: false,
    refundPending: false,
    ...over,
  });

  it('el importe nunca supera W - C y nunca es negativo', () => {
    fc.assert(
      fc.property(
        work,
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (w, c, ref) => {
          const a = settlementAmount(w, Math.min(c, w), ref);
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThanOrEqual(w - Math.min(c, w));
        },
      ),
    );
  });

  it('solo transfiere un pedido entregado, con cuenta activa, cobro y sin bloqueos; las claves son estables', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ORDER_STATUSES),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        id,
        (status, active, charge, incident, refunding, oid) => {
          const plan = planSettlement(
            base({
              orderStatus: status,
              accountActive: active,
              hasCharge: charge,
              shipmentIncident: incident,
              refundPending: refunding,
            }),
          );
          if (plan.action === 'transfer') {
            expect(status).toBe('entregado');
            expect(active && charge && !incident && !refunding).toBe(true);
          }
          expect(settlementKey(oid)).toBe(settlementKey(oid));
          expect(settlementKey(oid)).toBe(`liquidar:${oid}`);
        },
      ),
    );
  });

  it('respeta el retraso y reintenta mas tarde', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 720 }),
        fc.integer({ min: 0, max: 719 }),
        (delay, elapsedH) => {
          const plan = planSettlement(
            base({ delayHours: delay, deliveredAt: instantOf(NOW - elapsedH * MS.hour) }),
          );
          if (elapsedH < delay) expect(plan.action).toBe('wait');
          else expect(plan.action).toBe('transfer');
        },
      ),
    );
  });
});

describe('P-U5-09 y P-U5-10 retirada', () => {
  it('retira exactamente el disponible, exige sesion reciente y no existe en modo automatico', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.option(fc.integer({ min: 0, max: 60 * MS.minute }), { nil: undefined }),
        fc.boolean(),
        fc.boolean(),
        (retained, available, ageMs, open, automatic) => {
          const r = planWithdrawal({
            mode: automatic ? 'automatico' : 'manual',
            balance: { retainedCents: retained, availableCents: available },
            hasOpenWithdrawal: open,
            loginAt: ageMs === undefined ? undefined : NOW - ageMs,
            now: NOW,
            recentLoginMinutes: 15,
          });
          if (r.ok) {
            expect(automatic).toBe(false);
            expect(open).toBe(false);
            expect(r.value.amountCents).toBe(available);
            expect(available).toBeGreaterThan(0);
            expect(ageMs !== undefined && ageMs <= 15 * MS.minute).toBe(true);
          }
          if (automatic) expect(r).toEqual({ ok: false, error: 'automatic_mode' });
        },
      ),
    );
  });

  it('sesion reciente: ni futura ni mas vieja que el limite', () => {
    fc.assert(
      fc.property(fc.integer({ min: -MS.hour, max: 2 * MS.hour }), (age) => {
        expect(isRecentLogin(NOW - age, NOW, 15)).toBe(age >= 0 && age <= 15 * MS.minute);
      }),
    );
  });

  it('claves de retirada y reembolso distintas para entradas distintas', () => {
    fc.assert(
      fc.property(id, id, fc.nat(1000), fc.nat(1000), (a, b, n, m) => {
        fc.pre(a !== b || n !== m);
        expect(withdrawalKey(a, n) === withdrawalKey(b, m)).toBe(a === b && n === m);
        expect(refundKey(a, n) === refundKey(b, m)).toBe(a === b && n === m);
      }),
    );
  });
});

describe('P-U5-13 y P-U5-14 liberacion y entrega sin confirmar', () => {
  it('solo se libera desde etiqueta lista o en transito, con motivo y sin reembolso en curso', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ORDER_STATUSES),
        fc.boolean(),
        fc.string(),
        (status, refunding, reason) => {
          const r = canRelease({ status, refundPending: refunding, reason });
          if (r.ok) {
            expect(['etiqueta_lista', 'en_transito']).toContain(status);
            expect(refunding).toBe(false);
            expect(reason.trim().length).toBeGreaterThan(0);
          }
        },
      ),
    );
  });

  it('un pedido solo es «sin confirmar» en transito y pasado el plazo', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ORDER_STATUSES),
        fc.integer({ min: 0, max: 30 }),
        (status, days) => {
          const stale = staleDelivery(status, instantOf(NOW - days * 24 * MS.hour), NOW, 10);
          expect(stale).toBe(status === 'en_transito' && days >= 10);
        },
      ),
    );
  });

  it('liquidado y reembolsado son terminales', () => {
    for (const status of ['liquidado', 'reembolsado'] as const) {
      for (const trigger of [
        { type: 'settled' },
        { type: 'refund_total' },
        { type: 'payment_completed', canSell: true },
      ] as const) {
        expect(applyTrigger(status, trigger).changed).toBe(false);
      }
    }
  });
});

describe('P-U5-15 a P-U5-18 margen, enteros y datos personales', () => {
  const orderLike = (
    total: number,
    shipping: number,
    label: number | undefined,
    margin: number | undefined,
  ) =>
    ({
      id: 'o',
      totalCents: total,
      shippingCents: shipping,
      labelCostCents: label,
      marginCents: margin,
    }) as unknown as Order;

  it('el informe suma exactamente las lineas y cuenta los margenes negativos', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            total: fc.integer({ min: 200, max: 110_000 }),
            shipping: ship,
            label: fc.option(fc.integer({ min: 0, max: 5_000 }), { nil: undefined }),
            margin: fc.option(fc.integer({ min: -5_000, max: 5_000 }), { nil: undefined }),
          }),
          { maxLength: 20 },
        ),
        (rows) => {
          const orders = rows.map((r) => orderLike(r.total, r.shipping, r.label, r.margin));
          const rep = buildMarginReport(orders);
          const complete = rows.filter((r) => r.label !== undefined && r.margin !== undefined);
          expect(rep.orders).toBe(rows.length);
          expect(rep.marginCents).toBe(complete.reduce((s, r) => s + (r.margin ?? 0), 0));
          expect(rep.negativeMarginOrders).toBe(complete.filter((r) => (r.margin ?? 0) < 0).length);
          expect(rep.withoutLabelCost).toBe(rows.length - complete.length);
          expect(Number.isInteger(rep.marginCents)).toBe(true);
        },
      ),
    );
  });

  it('todos los importes del libro son enteros distintos de cero y el pago reparte T = W + E', () => {
    fc.assert(
      fc.property(work, ship, fc.integer({ min: 0, max: 100 }), (w, e, c) => {
        const entries = pay(w, e, Math.min(c, w));
        for (const x of entries) {
          expect(Number.isSafeInteger(x.deltaCents)).toBe(true);
          expect(x.deltaCents).not.toBe(0);
        }
        expect(entries.find((x) => x.kind === 'cobro')?.deltaCents).toBe(w + e);
        expect(conservationGap(entries)).toBe(0);
      }),
    );
  });

  it('el CSV no incluye datos personales y neutraliza formulas', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), (s) => {
        const cell = csvCell(`=${s}`);
        expect(cell.startsWith("'") || cell.startsWith('"\'')).toBe(true);
      }),
    );
    const csv = renderFinanceCsv({ ledger: [], settlements: [], withdrawals: [], refunds: [] });
    expect(csv.trim().split('\n')).toHaveLength(1);
    expect(csv).not.toMatch(/email|nombre|telefono|direccion/i);
  });
});
