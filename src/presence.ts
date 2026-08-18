// Optional, process-local V2 presence producer.
//
// Presence is observer output only. It reports only that an ask_user interaction
// is pending; it never carries questionnaire content or controls the tool.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPresenceProducer, MAX_INTEGER, type PresenceProducerHandle } from "@pi/presence";

export const PRESENCE_SOURCE = "interaction";

export interface PresenceRequestToken {
  readonly epoch: number;
}

/** Optional, process-local V2 producer. Questionnaire authority stays in the tool. */
export class AskUserPresence {
  private producer: PresenceProducerHandle | undefined;
  private sessionIdentity: string | null = null;
  private sessionStarted = false;
  private epoch = 0;
  private generation = 0;
  private sequence = 0;
  private pendingRequests = 0;
  private lifecycleOpen = false;

  constructor(private readonly pi: ExtensionAPI) {}

  /** A session always owns a fresh shared-protocol producer handle. */
  startSession(ctx: ExtensionContext): void {
    const identity = this.readSessionIdentity(ctx);
    if (!this.sessionStarted || identity !== this.sessionIdentity) {
      this.replaceSession(identity);
    } else {
      this.retryActivation();
    }
  }

  /** Withdraw the current lifecycle before releasing its source ownership. */
  stopSession(): void {
    this.withdraw();
    this.deactivate();
    this.epoch += 1;
    this.sessionStarted = false;
    this.sessionIdentity = null;
    this.pendingRequests = 0;
    this.lifecycleOpen = false;
    this.sequence = 0;
  }

  /** Claim one pending-input slot. The returned token fences a later finish. */
  beginRequest(ctx: ExtensionContext): PresenceRequestToken {
    const identity = this.readSessionIdentity(ctx);
    if (!this.sessionStarted || identity !== this.sessionIdentity) {
      this.replaceSession(identity);
    } else {
      // A source collision is temporary. Retrying must not replace the session,
      // since replacement would invalidate still-pending request tokens.
      this.retryActivation();
    }

    const token = { epoch: this.epoch };
    this.pendingRequests += 1;
    if (this.pendingRequests === 1) {
      this.openLifecycle();
    } else {
      this.publishWaiting("retained");
    }
    return token;
  }

  /** Release one slot. Stale tokens from a replaced session are ignored. */
  finishRequest(token: PresenceRequestToken): void {
    if (token.epoch !== this.epoch || this.pendingRequests === 0) return;
    this.pendingRequests -= 1;
    if (this.pendingRequests === 0) {
      this.withdraw();
    } else {
      this.publishWaiting("retained");
    }
  }

  private replaceSession(identity: string | null): void {
    this.withdraw();
    this.deactivate();
    this.epoch += 1;
    this.sessionStarted = true;
    this.sessionIdentity = identity;
    this.pendingRequests = 0;
    this.lifecycleOpen = false;
    this.sequence = 0;
    this.activate();
  }

  /** Activate only once; callers decide whether a recovered handle needs replay. */
  private activate(): boolean {
    if (this.producer) return false;
    try {
      const producer = createPresenceProducer({
        source: PRESENCE_SOURCE,
        emit: (eventName: string, payload: unknown) => this.emit(eventName, payload),
      });
      if (!producer?.activate()) return false;
      this.producer = producer;
      return true;
    } catch {
      // Presence setup is best-effort and cannot own questionnaire success.
      return false;
    }
  }

  /** Retry an unavailable source without changing session/token accounting. */
  private retryActivation(): void {
    if (this.activate() && this.lifecycleOpen && this.pendingRequests > 0) {
      this.publishWaiting("retained");
    }
  }

  private deactivate(): void {
    const producer = this.producer;
    this.producer = undefined;
    if (!producer) return;
    try {
      producer.deactivate();
    } catch {
      // Presence teardown cannot affect questionnaire cleanup.
    }
  }

  private openLifecycle(occurrence: "new" | "retained" = "new"): void {
    // A clean source re-registration resets shared ingress/consumer fences, so
    // bounded protocol ordinals can safely start over after generation exhaustion.
    if (this.generation >= MAX_INTEGER) {
      this.deactivate();
      this.generation = 0;
      this.sequence = 0;
    }
    this.generation += 1;
    this.sequence = 0;
    this.lifecycleOpen = true;
    this.activate();
    this.publishWaiting(occurrence);
  }

  private publishWaiting(occurrence: "new" | "retained"): boolean {
    if (!this.lifecycleOpen || this.pendingRequests === 0) return false;
    // Keep the final valid ordinal available for a synchronous withdrawal.
    if (this.sequence >= MAX_INTEGER - 1) return this.recycleLifecycle();

    const sequence = this.nextSequence();
    if (sequence === undefined) return false;
    try {
      if (
        !this.producer?.publishState({
          version: 2,
          generation: this.generation,
          sequence,
          source: PRESENCE_SOURCE,
          state: "waiting",
          interaction: { kind: "ask_user", pending: this.pendingRequests },
          attention: { reason: "input_required", occurrence },
        })
      ) {
        return false;
      }
      this.sequence = sequence;
      return true;
    } catch {
      // Observer failures are intentionally isolated from the questionnaire.
      return false;
    }
  }

  /**
   * Start a fresh registry lifecycle before a state would consume withdrawal's
   * last ordinal. A successful withdrawal is required before closing a local
   * lifecycle that has an active producer.
   */
  private recycleLifecycle(): boolean {
    if (!this.lifecycleOpen || this.pendingRequests === 0) return false;
    if (this.producer && !this.withdraw()) return false;
    if (!this.producer) this.lifecycleOpen = false;

    this.deactivate();
    this.generation = 0;
    this.sequence = 0;
    // Recycling preserves the pending interaction; it is not a 0→1 edge.
    this.openLifecycle("retained");
    return true;
  }

  private withdraw(): boolean {
    if (!this.lifecycleOpen) return true;
    const sequence = this.nextSequence();
    if (sequence === undefined) return false;

    // No handle means this lifecycle was never published, so local cleanup is
    // safe without a shared withdrawal.
    if (!this.producer) {
      this.lifecycleOpen = false;
      return true;
    }

    try {
      if (
        !this.producer.withdraw({
          version: 2,
          generation: this.generation,
          sequence,
          source: PRESENCE_SOURCE,
        })
      ) {
        return false;
      }
      this.sequence = sequence;
      this.lifecycleOpen = false;
      return true;
    } catch {
      // Keep the lifecycle open when shared publication failed so an invalid
      // ordinal never silently closes local accounting.
      return false;
    }
  }

  private nextSequence(): number | undefined {
    return this.sequence < MAX_INTEGER ? this.sequence + 1 : undefined;
  }

  /** Session identity only fences local tokens; it is never published. */
  private readSessionIdentity(ctx: ExtensionContext): string | null {
    try {
      const value = ctx.sessionManager.getSessionId();
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  private emit(eventName: string, payload: unknown): void {
    try {
      this.pi.events.emit(eventName, payload);
    } catch {
      // Presence is best-effort and cannot own questionnaire success or failure.
    }
  }
}
