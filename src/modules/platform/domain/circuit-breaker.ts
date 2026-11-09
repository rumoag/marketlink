import { addMs, MS, type Clock, type Instant } from '@/modules/kernel/domain/clock';

/** Interruptor de circuito por proveedor (BR-C1 a BR-C7). Puro: el tiempo viene del Clock. */
export type CircuitState = 'closed' | 'open' | 'half_open';

export type CircuitConfig = {
  readonly consecutiveFailures: number;
  readonly failureRate: number;
  readonly minCalls: number;
  readonly windowMs: number;
  readonly openMs: number;
};

export const DEFAULT_CIRCUIT_CONFIG: CircuitConfig = {
  consecutiveFailures: 5,
  failureRate: 0.5,
  minCalls: 10,
  windowMs: MS.minute,
  openMs: 30 * MS.second,
};

type Sample = { readonly at: Instant; readonly failed: boolean };

export class CircuitBreaker {
  private current: 'closed' | 'open' | 'half_open' = 'closed';
  private consecutive = 0;
  private samples: Sample[] = [];
  private openedAt: Instant | undefined;
  private probeInFlight = false;

  constructor(
    private readonly clock: Clock,
    private readonly config: CircuitConfig = DEFAULT_CIRCUIT_CONFIG,
  ) {}

  /** Estado visible; pasa de `open` a `half_open` cuando vence el tiempo de apertura. */
  state(): CircuitState {
    this.refresh();
    return this.current;
  }

  /**
   * Pide permiso para hacer una llamada. En `half_open` solo concede una simultanea (BR-C5).
   * Quien reciba `true` debe llamar despues a recordSuccess o recordFailure.
   */
  tryAcquire(): boolean {
    this.refresh();
    if (this.current === 'closed') return true;
    if (this.current === 'open') return false;
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.refresh();
    if (this.current === 'half_open') {
      this.close();
      return;
    }
    if (this.current === 'closed') {
      this.consecutive = 0;
      this.addSample(false);
    }
  }

  recordFailure(): void {
    this.refresh();
    if (this.current === 'half_open') {
      this.open();
      return;
    }
    if (this.current !== 'closed') return;
    this.consecutive += 1;
    this.addSample(true);
    if (this.consecutive >= this.config.consecutiveFailures || this.rateExceeded()) this.open();
  }

  private refresh(): void {
    if (
      this.current === 'open' &&
      this.openedAt !== undefined &&
      this.clock.now() >= addMs(this.openedAt, this.config.openMs)
    ) {
      this.current = 'half_open';
      this.probeInFlight = false;
    }
  }

  private addSample(failed: boolean): void {
    const now = this.clock.now();
    this.samples.push({ at: now, failed });
    const cutoff = now - this.config.windowMs;
    this.samples = this.samples.filter((s) => s.at > cutoff);
  }

  private rateExceeded(): boolean {
    const total = this.samples.length;
    if (total < this.config.minCalls) return false;
    const failed = this.samples.filter((s) => s.failed).length;
    return failed / total >= this.config.failureRate;
  }

  private open(): void {
    this.current = 'open';
    this.openedAt = this.clock.now();
    this.probeInFlight = false;
  }

  private close(): void {
    this.current = 'closed';
    this.consecutive = 0;
    this.samples = [];
    this.openedAt = undefined;
    this.probeInFlight = false;
  }
}
