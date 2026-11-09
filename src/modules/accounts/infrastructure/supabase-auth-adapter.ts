import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import { Email } from '@/modules/kernel/domain/formats';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { AuthPort, AuthSession } from '../application/ports';

export type SupabaseAuthOptions = {
  readonly url: string;
  /** Clave publicable: pide el enlace, verifica el token y renueva la sesion. */
  readonly publishableKey: string;
  /** Clave de servicio: solo para revocar sesiones. Nunca sale del servidor. */
  readonly serviceRoleKey: string;
  /** `fetch` resiliente (tiempo de espera, circuito, registro). */
  readonly fetch: typeof fetch;
  /** Base de la aplicacion: con ella el enlace lleva `emailRedirectTo` (artistas y operador). */
  readonly appUrl?: string;
};

const clientOptions = (f: typeof fetch) => ({
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: f },
});

/** AuthPort sobre Supabase Auth (enlace de acceso de un solo uso). */
export class SupabaseAuthAdapter implements AuthPort {
  private readonly anon: SupabaseClient;
  private readonly admin: SupabaseClient;
  private readonly appUrl: string | undefined;

  constructor(options: SupabaseAuthOptions) {
    this.appUrl = options.appUrl;
    this.anon = createClient(options.url, options.publishableKey, clientOptions(options.fetch));
    this.admin = createClient(options.url, options.serviceRoleKey, clientOptions(options.fetch));
  }

  async requestMagicLink(
    email: Email,
    redirect?: { readonly redirectPath?: string },
  ): Promise<Result<void, AppError>> {
    try {
      // El correo y la URL de confirmacion salen de la plantilla del proyecto (SiteURL).
      const { error } = await this.anon.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          ...(this.appUrl
            ? { emailRedirectTo: `${this.appUrl}${redirect?.redirectPath ?? '/acceso/confirmar'}` }
            : {}),
        },
      });
      return error ? err(appError('dependency_unavailable')) : ok(undefined);
    } catch {
      return err(appError('dependency_unavailable'));
    }
  }

  async verifySignIn(tokenHash: string): Promise<Result<AuthSession, AppError>> {
    try {
      const { data, error } = await this.anon.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'email',
      });
      const session = data.session;
      const email = data.user?.email;
      if (error || !session || !data.user || !email) return err(appError('unauthenticated'));
      return toSession(data.user.id, email, session.access_token, session.refresh_token);
    } catch {
      return err(appError('dependency_unavailable'));
    }
  }

  async verifyAccessToken(accessToken: string): Promise<{ userId: string; email: Email } | null> {
    try {
      // Con claves de firma asimetricas la verificacion es local; si no, consulta al servidor.
      const { data, error } = await this.anon.auth.getClaims(accessToken);
      const claims = data?.claims;
      if (error || !claims || typeof claims.sub !== 'string') return null;
      const email = Email.parse(typeof claims.email === 'string' ? claims.email : '');
      return email.ok ? { userId: claims.sub, email: email.value } : null;
    } catch {
      return null;
    }
  }

  async refresh(refreshToken: string): Promise<Result<AuthSession, AppError>> {
    try {
      const { data, error } = await this.anon.auth.refreshSession({ refresh_token: refreshToken });
      const session = data.session;
      const email = data.user?.email;
      if (error || !session || !data.user || !email) return err(appError('unauthenticated'));
      return toSession(data.user.id, email, session.access_token, session.refresh_token);
    } catch {
      return err(appError('dependency_unavailable'));
    }
  }

  async signOut(accessToken: string): Promise<void> {
    await this.admin.auth.admin.signOut(accessToken, 'global');
  }
}

const toSession = (
  userId: string,
  rawEmail: string,
  accessToken: string,
  refreshToken: string,
): Result<AuthSession, AppError> => {
  const email = Email.parse(rawEmail);
  if (!email.ok) return err(appError('unauthenticated'));
  return ok({ userId, email: email.value, accessToken, refreshToken });
};
