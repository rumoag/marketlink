/**
 * Estado de cobros del artista (BR2-CB1 a CB6). Funciones puras: el dominio nunca ve la respuesta
 * cruda del proveedor, solo este resumen.
 */
export const PAYOUT_STATUSES = [
  'sin_iniciar',
  'onboarding_pendiente',
  'activo',
  'restringido',
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export type RequirementsHint = 'info_pendiente' | 'verificacion_pendiente' | 'deshabilitada';

/** Resumen de la cuenta en el proveedor, con el instante del evento que lo origino. */
export type AccountSnapshot = {
  readonly detailsSubmitted: boolean;
  readonly transfersActive: boolean;
  readonly payoutsEnabled: boolean;
  readonly disabled: boolean;
  /** Milisegundos desde la epoca del evento del proveedor. */
  readonly eventAt: number;
};

export type PayoutState = {
  readonly status: PayoutStatus;
  readonly requirementsHint?: RequirementsHint;
  /** Instante del ultimo evento aplicado; los eventos mas antiguos se ignoran (BR2-CB5). */
  readonly lastEventAt?: number;
};

export const INITIAL_PAYOUT_STATE: PayoutState = { status: 'sin_iniciar' };

/** Lo que exige nuestro modelo: la cuenta recibe transferencias y puede cobrar a su banco. */
export const isFullyEnabled = (s: AccountSnapshot): boolean =>
  s.transfersActive && s.payoutsEnabled && !s.disabled;

/**
 * BR2-CB4. `hasAccount` indica que ya existe una cuenta en el proveedor.
 * - activo: transferencias y pagos habilitados y no deshabilitada.
 * - restringido: estaba activo o restringido y ya no cumple.
 * - onboarding_pendiente: cualquier otro caso con cuenta.
 */
export const nextPayoutStatus = (
  current: PayoutStatus,
  snapshot: AccountSnapshot,
  hasAccount = true,
): PayoutStatus => {
  if (!hasAccount) return 'sin_iniciar';
  if (isFullyEnabled(snapshot)) return 'activo';
  if (current === 'activo' || current === 'restringido') return 'restringido';
  return 'onboarding_pendiente';
};

export const hintFor = (s: AccountSnapshot): RequirementsHint | undefined => {
  if (isFullyEnabled(s)) return undefined;
  if (s.disabled) return 'deshabilitada';
  if (!s.detailsSubmitted) return 'info_pendiente';
  return 'verificacion_pendiente';
};

export type AppliedEvent = {
  readonly state: PayoutState;
  /** Falso si el evento era mas antiguo que el ultimo aplicado. */
  readonly applied: boolean;
  /** Verdadero solo en la transicion a restringido (dispara la pausa de enlaces). */
  readonly becameRestricted: boolean;
};

/** Aplica un evento de cuenta (P-U2-11): idempotente y tolerante al desorden. */
export const applyAccountEvent = (state: PayoutState, snapshot: AccountSnapshot): AppliedEvent => {
  if (state.lastEventAt !== undefined && snapshot.eventAt < state.lastEventAt) {
    return { state, applied: false, becameRestricted: false };
  }
  const status = nextPayoutStatus(state.status, snapshot);
  const hint = hintFor(snapshot);
  const next: PayoutState = {
    status,
    ...(hint !== undefined ? { requirementsHint: hint } : {}),
    lastEventAt: snapshot.eventAt,
  };
  return {
    state: next,
    applied: true,
    becameRestricted: status === 'restringido' && state.status !== 'restringido',
  };
};
