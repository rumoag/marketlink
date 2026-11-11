import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PostalCode } from '@/modules/kernel/domain/formats';
import { instantOf } from '@/modules/kernel/domain/clock';
import { normalizeInstagram, parseInstagram } from '@/modules/accounts/domain/instagram-handle';
import { parsePeninsularPostalCode } from '@/modules/accounts/domain/postal';
import {
  PENINSULAR_PREFIXES,
  PROVINCES_BY_PREFIX,
  provinceMatchesPostalCode,
} from '@/modules/accounts/domain/provinces';
import {
  applyAccountEvent,
  isFullyEnabled,
  nextPayoutStatus,
  PAYOUT_STATUSES,
  type PayoutState,
} from '@/modules/accounts/domain/payout';
import {
  isSessionValid,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  shouldRenewActivity,
} from '@/modules/accounts/domain/session';
import { MS } from '@/modules/kernel/domain/clock';
import { validPostalArb } from '@tests/support/generators';
import {
  excludedPrefixArb,
  peninsularPrefixArb,
  postalWithPrefixArb,
  provinceAliasArb,
  snapshotArb,
  validInstagramArb,
} from '@tests/support/u2-generators';
import { buildHarness } from '@tests/support/harness';
import type { Listing } from '@/modules/listings/domain/listing';
import type { Slug } from '@/modules/listings/domain/slug';

// ---------------------------------------------------------------------------------------------
describe('P-U2-04 InstagramHandle', () => {
  const reference = (n: string): boolean =>
    /^[a-z0-9._]{1,30}$/.test(n) && !n.startsWith('.') && !n.endsWith('.') && !n.includes('..');

  it('normalize es idempotente', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (x) => {
        expect(normalizeInstagram(normalizeInstagram(x))).toBe(normalizeInstagram(x));
      }),
    );
  });

  it('parse acepta sii cumple la regla (1 a 30, alfabeto y puntos) y nunca lanza', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 40 }), validInstagramArb), (x) => {
        expect(parseInstagram(x).ok).toBe(reference(normalizeInstagram(x)));
      }),
    );
  });

  it('el @ inicial es opcional y las mayusculas se pliegan', () => {
    fc.assert(
      fc.property(validInstagramArb, (h) => {
        const plain = parseInstagram(h);
        const withAt = parseInstagram(`@${h.toUpperCase()}`);
        expect(plain.ok).toBe(true);
        expect(withAt).toEqual(plain);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-05 PeninsularPostalCode', () => {
  it('acepta sii es un PostalCode valido de la peninsula', () => {
    fc.assert(
      fc.property(fc.oneof(validPostalArb, fc.string({ maxLength: 8 })), (x) => {
        const base = PostalCode.parse(x);
        const expected =
          base.ok && !['07', '35', '38', '51', '52'].includes(base.value.slice(0, 2));
        expect(parsePeninsularPostalCode(x).ok).toBe(expected);
      }),
    );
  });

  it('los prefijos excluidos se rechazan y los peninsulares se aceptan', () => {
    fc.assert(
      fc.property(postalWithPrefixArb(excludedPrefixArb), (cp) => {
        const r = parsePeninsularPostalCode(cp);
        expect(!r.ok && r.error).toBe('outside_peninsula');
      }),
    );
    fc.assert(
      fc.property(postalWithPrefixArb(peninsularPrefixArb), (cp) => {
        expect(parsePeninsularPostalCode(cp).ok).toBe(true);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-06 provincias por prefijo', () => {
  it('la tabla cubre exactamente los 47 prefijos peninsulares', () => {
    expect(PENINSULAR_PREFIXES).toHaveLength(47);
    for (const excluded of ['07', '35', '38', '51', '52']) {
      expect(PROVINCES_BY_PREFIX[excluded]).toBeUndefined();
    }
  });

  it('acepta los nombres de su prefijo (con otras mayusculas y sin acentos) y rechaza los de otros', () => {
    fc.assert(
      fc.property(
        provinceAliasArb,
        peninsularPrefixArb,
        fc.integer({ min: 0, max: 999 }),
        (alias, otherPrefix, rest) => {
          const cp = `${otherPrefix}${String(rest).padStart(3, '0')}`;
          const noAccents = alias.name
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .toUpperCase();
          const sameProvince = otherPrefix === alias.prefix;
          expect(provinceMatchesPostalCode(cp, alias.name)).toBe(sameProvince);
          expect(provinceMatchesPostalCode(cp, `  ${noAccents}  `)).toBe(sameProvince);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-10 nextPayoutStatus', () => {
  it('activo sii transfers y payouts activos y no deshabilitada; con cuenta nunca sin_iniciar', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PAYOUT_STATUSES), snapshotArb(), (current, snap) => {
        const next = nextPayoutStatus(current, snap);
        expect(next === 'activo').toBe(isFullyEnabled(snap));
        expect(next).not.toBe('sin_iniciar');
        if (!isFullyEnabled(snap)) {
          expect(next).toBe(
            current === 'activo' || current === 'restringido'
              ? 'restringido'
              : 'onboarding_pendiente',
          );
        }
      }),
    );
  });

  it('sin cuenta en el proveedor es sin_iniciar', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PAYOUT_STATUSES), snapshotArb(), (current, snap) => {
        expect(nextPayoutStatus(current, snap, false)).toBe('sin_iniciar');
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-11 aplicar eventos de cuenta', () => {
  const initial: PayoutState = { status: 'sin_iniciar' };

  it('aplicar dos veces el mismo evento deja el mismo estado', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PAYOUT_STATUSES), snapshotArb(), (status, snap) => {
        const start: PayoutState = { status };
        const once = applyAccountEvent(start, snap).state;
        const twice = applyAccountEvent(once, snap).state;
        expect(twice).toEqual(once);
      }),
    );
  });

  it('un evento mas antiguo que el ultimo aplicado no cambia nada', () => {
    fc.assert(
      fc.property(
        snapshotArb(fc.integer({ min: 100, max: 1000 })),
        snapshotArb(fc.integer({ min: 0, max: 99 })),
        (newer, older) => {
          const state = applyAccountEvent(initial, newer).state;
          const result = applyAccountEvent(state, older);
          expect(result.applied).toBe(false);
          expect(result.state).toEqual(state);
          expect(result.becameRestricted).toBe(false);
        },
      ),
    );
  });

  it('en cualquier orden de llegada el estado final refleja el evento mas reciente', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(snapshotArb(), { selector: (s) => s.eventAt, minLength: 1, maxLength: 8 }),
        (events) => {
          const latest = events.reduce((a, b) => (b.eventAt > a.eventAt ? b : a));
          const run = (order: typeof events): PayoutState =>
            order.reduce<PayoutState>((s, e) => applyAccountEvent(s, e).state, initial);
          for (const order of [events, [...events].reverse()]) {
            const finalState = run(order);
            expect(finalState.lastEventAt).toBe(latest.eventAt);
            expect(finalState.status === 'activo').toBe(isFullyEnabled(latest));
          }
        },
      ),
    );
  });

  it('becameRestricted solo en la transicion a restringido', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PAYOUT_STATUSES), snapshotArb(), (status, snap) => {
        const result = applyAccountEvent({ status }, snap);
        expect(result.becameRestricted).toBe(
          result.state.status === 'restringido' && status !== 'restringido',
        );
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-20 vigencia de la sesion', () => {
  const t = (ms: number) => instantOf(ms);

  it('valida sii menos de 7 dias de inactividad y menos de 30 desde el inicio', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 * MS.day }),
        fc.integer({ min: 0, max: 40 * MS.day }),
        (sinceStart, sinceActivity) => {
          // la actividad no puede ser anterior al inicio
          const idle = Math.min(sinceActivity, sinceStart);
          const now = t(100 * MS.day);
          const session = { createdAt: t(now - sinceStart), lastActivityAt: t(now - idle) };
          expect(isSessionValid(session, now)).toBe(
            idle < SESSION_IDLE_MS && sinceStart < SESSION_MAX_MS,
          );
        },
      ),
    );
  });

  it('es monotona: una vez invalida lo sigue siendo en cualquier instante posterior', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 * MS.day }),
        fc.integer({ min: 0, max: 30 * MS.day }),
        (age, later) => {
          const session = { createdAt: t(0), lastActivityAt: t(0) };
          const now = t(age);
          if (!isSessionValid(session, now))
            expect(isSessionValid(session, t(age + later))).toBe(false);
        },
      ),
    );
  });

  it('la actividad se renueva como mucho cada 5 minutos', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 * MS.minute }), (elapsed) => {
        const session = { createdAt: t(0), lastActivityAt: t(0) };
        expect(shouldRenewActivity(session, t(elapsed))).toBe(elapsed >= 5 * MS.minute);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-U2-12 pausa por restriccion de cobros', () => {
  it('no queda ningun enlace activo, el resto no cambia y repetirlo no cambia nada', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('activo', 'pausado', 'vendido' as const), {
          minLength: 0,
          maxLength: 8,
        }),
        async (statuses) => {
          const h = buildHarness();
          const artistId = await h.readyArtist();
          const before = new Map<string, Listing>();
          statuses.forEach((status, i) => {
            const listing: Listing = {
              id: `00000000-0000-4000-8000-${String(900 + i).padStart(12, '0')}`,
              artistId,
              slug: `abcdefg${'23456789'[i] ?? '2'}` as Slug,
              title: 'Obra de prueba',
              description: '',
              priceCents: 1000,
              declaredValueCents: 1000,
              fragile: false,
              size: 'M',
              modality: 'punto',
              origins: ['punto'],
              status,
              pausedReason: status === 'pausado' ? 'artista' : undefined,
              orderId: undefined,
              createdAt: instantOf(0),
              updatedAt: instantOf(0),
              soldAt: status === 'vendido' ? instantOf(1) : undefined,
            };
            h.db.state.listings.set(listing.id, listing);
            before.set(listing.id, listing);
          });

          const restricted = { ...h.enabledSnapshot(h.clock.now() + 10), disabled: true };
          await h.apply.applySnapshot(artistId, restricted, 'c');

          for (const [id, original] of before) {
            const now = h.db.state.listings.get(id) as Listing;
            expect(now.status).not.toBe('activo');
            if (original.status === 'activo') {
              expect(now.status).toBe('pausado');
              expect(now.pausedReason).toBe('cobros_restringidos');
            } else {
              expect(now).toEqual(original);
            }
          }

          // Repetir un evento posterior igualmente restringido no cambia nada.
          const snapshotOfListings = structuredClone([...h.db.state.listings.values()]);
          await h.apply.applySnapshot(
            artistId,
            { ...restricted, eventAt: restricted.eventAt + 5 },
            'c',
          );
          expect([...h.db.state.listings.values()]).toEqual(snapshotOfListings);
        },
      ),
      { numRuns: 40 },
    );
  });
});
