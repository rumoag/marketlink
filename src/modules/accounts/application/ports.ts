import type { AppError } from '@/modules/kernel/domain/app-error';
import type { Instant } from '@/modules/kernel/domain/clock';
import type { Email } from '@/modules/kernel/domain/formats';
import type { Result } from '@/modules/kernel/domain/result';
import type { AddressInput, Artist, ProfileInput, SenderAddress } from '../domain/artist';
import type { AccountSnapshot, PayoutState } from '../domain/payout';

/** Sesion que devuelve el proveedor de autenticacion tras confirmar el enlace. */
export type AuthSession = {
  readonly userId: string;
  readonly email: Email;
  readonly accessToken: string;
  readonly refreshToken: string;
};

/** Autenticacion sin contrasena (Supabase Auth). */
export interface AuthPort {
  /** Pide al proveedor que envie el enlace; no revela si la cuenta existe. */
  requestMagicLink(
    email: Email,
    options?: { readonly redirectPath?: string },
  ): Promise<Result<void, AppError>>;
  /** Consume el enlace (un solo uso). Cualquier fallo se trata igual aguas arriba. */
  verifySignIn(tokenHash: string): Promise<Result<AuthSession, AppError>>;
  /** Verifica la firma y la caducidad del token de acceso, sin llamada de red cuando es posible. */
  verifyAccessToken(accessToken: string): Promise<{ userId: string; email: Email } | null>;
  /** Renueva la sesion con el token de refresco (rotatorio). */
  refresh(refreshToken: string): Promise<Result<AuthSession, AppError>>;
  /** Revoca la sesion del proveedor (cerrar sesion). */
  signOut(accessToken: string): Promise<void>;
}

/**
 * Evento ya verificado. Los eventos de cuenta de Stripe (Accounts v2) son «finos»: solo identifican
 * la cuenta. El estado se consulta al procesar el trabajo (`getAccountSnapshot`), sin datos
 * personales en lo que se guarda (BR-J9).
 */
export type ConnectEvent = {
  readonly id: string;
  readonly type: string;
  readonly providerAccountId: string;
  /** Milisegundos desde la epoca en que el proveedor emitio el evento. */
  readonly occurredAt: number;
};

/** Cobros (Stripe Connect, cuentas v2 con panel Express). El dominio nunca ve respuestas crudas del proveedor. */
export interface PayoutProvider {
  createAccount(input: {
    artistId: string;
    email: Email;
  }): Promise<Result<{ providerAccountId: string }, AppError>>;
  createOnboardingLink(
    providerAccountId: string,
    urls: { returnUrl: string; refreshUrl: string },
  ): Promise<Result<{ url: string }, AppError>>;
  getAccountSnapshot(providerAccountId: string): Promise<Result<AccountSnapshot, AppError>>;
  /** Verifica la firma sobre el cuerpo crudo y reduce el evento. */
  parseEvent(rawBody: string, signature: string): Result<ConnectEvent | null, 'invalid_signature'>;
}

export type PayoutRecord = {
  readonly artistId: string;
  readonly providerAccountId: string | undefined;
  readonly state: PayoutState;
};

export interface ArtistRepository {
  findById(id: string): Promise<Artist | undefined>;
  /** Crea el artista si no existe (registro abierto) y lo devuelve. */
  upsertOnSignIn(id: string, email: Email, now: Instant): Promise<Artist>;
  saveProfile(id: string, profile: ProfileInput, now: Instant): Promise<Artist>;
}

export interface SenderAddressRepository {
  find(artistId: string): Promise<SenderAddress | undefined>;
  save(artistId: string, address: AddressInput, now: Instant): Promise<SenderAddress>;
}

export interface PayoutAccountRepository {
  find(artistId: string): Promise<PayoutRecord | undefined>;
  findByProviderAccountId(providerAccountId: string): Promise<PayoutRecord | undefined>;
  /** Bloquea la fila del artista hasta el fin de la transaccion (crea el registro si falta). */
  lockForUpdate(artistId: string): Promise<PayoutRecord>;
  setProviderAccount(artistId: string, providerAccountId: string, now: Instant): Promise<void>;
  saveState(artistId: string, state: PayoutState, now: Instant): Promise<void>;
}

/** Subconjunto de repositorios que usa el modulo de cuentas. */
export type AccountsRepos = {
  readonly artists: ArtistRepository;
  readonly addresses: SenderAddressRepository;
  readonly payouts: PayoutAccountRepository;
};

/** Aplica un snapshot al estado de cobros (lo implementa la capa de coordinacion). */
export interface PayoutStateApplier {
  applySnapshot(
    artistId: string,
    snapshot: AccountSnapshot,
    correlationId: string,
  ): Promise<Result<{ becameRestricted: boolean }, AppError>>;
}
