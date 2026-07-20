import type { ActivitySessionCredentials } from './contracts.js';

export type ActivityConnectionState =
  'active' | 'disconnected' | 'expired' | 'stopped';

export interface ActivitySessionControllerOptions {
  now?: () => number;
  refresh: (sessionToken: string) => Promise<ActivitySessionCredentials>;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onSession?: (session: ActivitySessionCredentials) => void;
  onState?: (state: ActivityConnectionState) => void;
  onExpired?: () => void;
  refreshLeadMs?: number;
  retryDelayMs?: number;
}

function timestamp(value: string, code: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(code);
  return result;
}

function terminalSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /expired|revoked|invalid|not_found|unauthorized/i.test(message);
}

export class ActivitySessionController {
  private session: ActivitySessionCredentials;
  private readonly absoluteExpiry: number;
  private readonly now: () => number;
  private readonly scheduleCallback: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
  private readonly cancelCallback: (handle: unknown) => void;
  private handle: unknown;
  private refreshInFlight: Promise<void> | undefined;
  private connectionState: ActivityConnectionState = 'active';
  private stopped = false;

  constructor(
    initialSession: ActivitySessionCredentials,
    private readonly options: ActivitySessionControllerOptions,
  ) {
    this.session = { ...initialSession };
    this.absoluteExpiry = timestamp(
      initialSession.expiresAt,
      'activity_session_expiry_invalid',
    );
    timestamp(
      initialSession.idleExpiresAt,
      'activity_session_idle_expiry_invalid',
    );
    this.now = options.now ?? Date.now;
    this.scheduleCallback =
      options.schedule ??
      ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.cancelCallback =
      options.cancel ?? ((handle) => window.clearTimeout(handle as number));
  }

  current(): ActivitySessionCredentials {
    return { ...this.session };
  }

  state(): ActivityConnectionState {
    return this.connectionState;
  }

  start(): void {
    if (this.stopped) return;
    if (this.isExpired()) {
      this.expire();
      return;
    }
    this.setState('active');
    this.scheduleRefresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== undefined) this.cancelCallback(this.handle);
    this.handle = undefined;
    this.setState('stopped');
  }

  refreshNow(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const operation = this.performRefresh();
    const tracked = operation.finally(() => {
      if (this.refreshInFlight === tracked) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = tracked;
    return tracked;
  }

  private async performRefresh(): Promise<void> {
    if (this.stopped) return;
    if (this.isExpired()) {
      this.expire();
      return;
    }
    try {
      const replacement = await this.options.refresh(this.session.sessionToken);
      if (this.stopped) return;
      const replacementExpiry = timestamp(
        replacement.expiresAt,
        'activity_session_expiry_invalid',
      );
      const replacementIdleExpiry = timestamp(
        replacement.idleExpiresAt,
        'activity_session_idle_expiry_invalid',
      );
      if (
        replacementExpiry > this.absoluteExpiry ||
        replacementExpiry <= this.now() ||
        replacementIdleExpiry <= this.now() ||
        replacementIdleExpiry > replacementExpiry ||
        !replacement.sessionToken
      )
        throw new Error('activity_session_refresh_invalid');

      this.session = { ...replacement };
      this.setState('active');
      this.options.onSession?.(this.current());
      this.scheduleRefresh();
    } catch (error) {
      if (this.stopped) return;
      if (this.isExpired() || terminalSessionError(error)) {
        this.expire();
        return;
      }
      this.setState('disconnected');
      this.scheduleRetry();
    }
  }

  private isExpired(): boolean {
    return (
      this.now() >= this.absoluteExpiry ||
      this.now() >=
        timestamp(
          this.session.idleExpiresAt,
          'activity_session_idle_expiry_invalid',
        )
    );
  }

  private scheduleRefresh(): void {
    if (this.stopped) return;
    if (this.handle !== undefined) this.cancelCallback(this.handle);
    const idleExpiry = timestamp(
      this.session.idleExpiresAt,
      'activity_session_idle_expiry_invalid',
    );
    const lead = this.options.refreshLeadMs ?? 60_000;
    const delay = Math.max(0, idleExpiry - this.now() - lead);
    this.handle = this.scheduleCallback(() => {
      this.handle = undefined;
      void this.refreshNow();
    }, delay);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.handle !== undefined) this.cancelCallback(this.handle);
    this.handle = this.scheduleCallback(() => {
      this.handle = undefined;
      void this.refreshNow();
    }, this.options.retryDelayMs ?? 5_000);
  }

  private expire(): void {
    if (this.connectionState === 'expired') return;
    if (this.handle !== undefined) this.cancelCallback(this.handle);
    this.handle = undefined;
    this.setState('expired');
    this.options.onExpired?.();
  }

  private setState(state: ActivityConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.options.onState?.(state);
  }
}
