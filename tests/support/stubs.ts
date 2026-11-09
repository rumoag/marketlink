import { appError, type AppError } from '@/modules/kernel/domain/app-error';
import type { Random } from '@/modules/kernel/domain/clock';
import type { Email } from '@/modules/kernel/domain/formats';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type {
  AuthPort,
  AuthSession,
  ConnectEvent,
  PayoutProvider,
} from '@/modules/accounts/application/ports';
import type { AccountSnapshot } from '@/modules/accounts/domain/payout';
import type {
  ImageProcessor,
  PhotoStorage,
  ProcessedImage,
} from '@/modules/listings/application/ports';
import type { PhotoError } from '@/modules/listings/domain/photo-rules';
import type { IdGenerator } from '@/modules/platform/application/ports';

/** Identificadores UUID v4 validos y deterministas (z.uuid() exige la variante RFC). */
export class SeqIds implements IdGenerator {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`;
  }
}

/**
 * Aleatoriedad determinista. Con valores dados los recorre en bucle; sin ellos usa un generador
 * congruencial que no se repite, para que dos altas seguidas no produzcan el mismo slug.
 */
export class SeqRandom implements Random {
  private i = 0;
  private state: number;
  constructor(
    private readonly values?: readonly number[],
    seed = 12345,
  ) {
    this.state = seed;
  }
  next(): number {
    if (this.values && this.values.length > 0) {
      const v = this.values[this.i % this.values.length] ?? 0;
      this.i += 1;
      return v;
    }
    this.state = (this.state * 1103515245 + 12345) % 2147483648;
    return this.state / 2147483648;
  }
}

export class StubAuth implements AuthPort {
  readonly sent: Email[] = [];
  failSend = false;
  failVerifyAsDown = false;
  private readonly links = new Map<string, Email>();
  private readonly users = new Map<string, string>();
  private n = 0;

  /** Registra un enlace valido para `email` y devuelve su token. */
  issue(email: Email): string {
    this.n += 1;
    const tokenHash = `token-${this.n}`;
    this.links.set(tokenHash, email);
    return tokenHash;
  }

  requestMagicLink(email: Email): Promise<Result<void, AppError>> {
    if (this.failSend) return Promise.resolve(err(appError('dependency_unavailable')));
    this.sent.push(email);
    return Promise.resolve(ok(undefined));
  }

  verifySignIn(tokenHash: string): Promise<Result<AuthSession, AppError>> {
    if (this.failVerifyAsDown) return Promise.resolve(err(appError('dependency_unavailable')));
    const email = this.links.get(tokenHash);
    this.links.delete(tokenHash);
    if (!email) return Promise.resolve(err(appError('unauthenticated')));
    let userId = this.users.get(email);
    if (!userId) {
      userId = `00000000-0000-4000-9000-${String(this.users.size + 1).padStart(12, '0')}`;
      this.users.set(email, userId);
    }
    return Promise.resolve(
      ok({ userId, email, accessToken: `at-${userId}`, refreshToken: `rt-${userId}` }),
    );
  }

  verifyAccessToken(): Promise<{ userId: string; email: Email } | null> {
    return Promise.resolve(null);
  }

  refresh(): Promise<Result<AuthSession, AppError>> {
    return Promise.resolve(err(appError('unauthenticated')));
  }

  signOut(): Promise<void> {
    return Promise.resolve();
  }
}

export class StubPayout implements PayoutProvider {
  down = false;
  readonly createAccountCalls: string[] = [];
  readonly linkCalls: string[] = [];
  readonly snapshots = new Map<string, AccountSnapshot>();

  createAccount(input: {
    artistId: string;
  }): Promise<Result<{ providerAccountId: string }, AppError>> {
    if (this.down) return Promise.resolve(err(appError('dependency_unavailable')));
    this.createAccountCalls.push(input.artistId);
    return Promise.resolve(ok({ providerAccountId: `acct_${input.artistId.slice(-6)}` }));
  }

  createOnboardingLink(providerAccountId: string): Promise<Result<{ url: string }, AppError>> {
    if (this.down) return Promise.resolve(err(appError('dependency_unavailable')));
    this.linkCalls.push(providerAccountId);
    return Promise.resolve(ok({ url: `https://onboarding.test/${providerAccountId}` }));
  }

  getAccountSnapshot(providerAccountId: string): Promise<Result<AccountSnapshot, AppError>> {
    if (this.down) return Promise.resolve(err(appError('dependency_unavailable')));
    const s = this.snapshots.get(providerAccountId);
    return Promise.resolve(s ? ok(s) : err(appError('not_found')));
  }

  /** Firma "valida" si es exactamente `valid`; el cuerpo es un ConnectEvent en JSON. */
  parseEvent(rawBody: string, signature: string): Result<ConnectEvent | null, 'invalid_signature'> {
    if (signature !== 'valid') return err('invalid_signature');
    const parsed = JSON.parse(rawBody) as ConnectEvent | { ignore: true };
    return 'ignore' in parsed ? ok(null) : ok(parsed);
  }
}

export class StubStorage implements PhotoStorage {
  readonly objects = new Map<string, Uint8Array>();
  /** Falla la N-esima llamada a `put` (1 = la primera). */
  failPutOnCall: number | undefined;
  failRemove = false;
  failSign = false;
  signCalls = 0;
  private puts = 0;

  put(key: string, bytes: Uint8Array): Promise<Result<void, AppError>> {
    this.puts += 1;
    if (this.failPutOnCall === this.puts) {
      return Promise.resolve(err(appError('dependency_unavailable')));
    }
    this.objects.set(key, bytes);
    return Promise.resolve(ok(undefined));
  }

  remove(keys: readonly string[]): Promise<Result<void, AppError>> {
    if (this.failRemove) return Promise.resolve(err(appError('dependency_unavailable')));
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve(ok(undefined));
  }

  signUrls(keys: readonly string[]): Promise<Result<ReadonlyMap<string, string>, AppError>> {
    this.signCalls += 1;
    if (this.failSign) return Promise.resolve(err(appError('dependency_unavailable')));
    return Promise.resolve(ok(new Map(keys.map((k) => [k, `https://signed.test/${k}`]))));
  }
}

export class StubProcessor implements ImageProcessor {
  failWith: PhotoError | undefined;

  process(bytes: Uint8Array): Promise<Result<ProcessedImage, PhotoError>> {
    if (this.failWith) return Promise.resolve(err(this.failWith));
    return Promise.resolve(
      ok({
        full: { bytes: bytes.slice(0, 16), width: 1600, height: 1200 },
        thumb: { bytes: bytes.slice(0, 8), width: 480, height: 360 },
      }),
    );
  }
}
