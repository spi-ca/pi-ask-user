// Optional, process-local presence producer.
//
// Publishes `pi-presence:update:v1` / `pi-presence:remove:v1` on the in-process
// event bus so an installed consumer such as `pi-cmux-presence` can surface a
// "Pi needs your input" state. Presence is observer output only: every emit is
// best-effort and can never fail or delay the questionnaire itself.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PRESENCE_UPDATE_EVENT = "pi-presence:update:v1";
export const PRESENCE_REMOVE_EVENT = "pi-presence:remove:v1";
export const PRESENCE_READY_EVENT = "pi-presence:ready:v1";
export const PRESENCE_REMOVE_CAPABILITY = "presence-remove-v1";
export const PRESENCE_CONSUMER_ID = "pi-cmux-presence";
export const PRESENCE_SOURCE_ID = "ask-user";
export const PRESENCE_SOURCE_LABEL = "Pi needs your input";
export const MAX_PRESENCE_TEXT = 96;

export interface PresenceRequestToken {
  epoch: number;
}

/**
 * Event-contract safe text: 1–96 Unicode code points with no control or
 * bidi-affecting characters. Used for session ids before they are published.
 */
export function safePresenceText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PRESENCE_TEXT * 2) return false;
  if ([...value].length > MAX_PRESENCE_TEXT) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return false;
    }
  }
  return true;
}

/** Optional, process-local presence producer. Questionnaire authority stays in the tool. */
export class AskUserPresence {
  private sessionId: string | null = null;
  private advertisedSessionId: string | null = null;
  private generation = 0;
  private lastGeneration = 0;
  private sequence = 0;
  private pendingRequests = 0;
  private epoch = 0;
  private removalSupported = false;
  private published = false;

  constructor(private readonly pi: ExtensionAPI) {}

  /** Record a consumer advertisement. Only exact remove-capable consumers enable output. */
  handleReady(payload: unknown): void {
    try {
      if (!payload || typeof payload !== "object") return;
      const ready = payload as {
        version?: unknown;
        sessionId?: unknown;
        consumer?: unknown;
      };
      if (ready.version !== 1 || !safePresenceText(ready.sessionId)) return;
      if (!ready.consumer || typeof ready.consumer !== "object") return;
      const consumer = ready.consumer as { id?: unknown; capabilities?: unknown };
      if (
        consumer.id !== PRESENCE_CONSUMER_ID ||
        !Array.isArray(consumer.capabilities) ||
        !consumer.capabilities.includes(PRESENCE_REMOVE_CAPABILITY)
      ) {
        return;
      }

      this.advertisedSessionId = ready.sessionId;
      if (ready.sessionId !== this.sessionId) return;
      this.removalSupported = true;
      if (this.pendingRequests > 0) this.publishWaiting("none");
    } catch {
      // Event-bus payloads are advisory and must never interrupt the questionnaire.
    }
  }

  startSession(ctx: ExtensionContext): void {
    const sessionId = this.readSessionId(ctx);
    this.resetSession(sessionId);
  }

  stopSession(): void {
    this.withdraw();
    this.epoch += 1;
    this.sessionId = null;
    this.removalSupported = false;
    this.pendingRequests = 0;
  }

  /** Claim one pending-input slot. The returned token fences a later finish. */
  beginRequest(ctx: ExtensionContext): PresenceRequestToken {
    const sessionId = this.readSessionId(ctx);
    if (sessionId !== this.sessionId) {
      this.withdraw();
      this.resetSession(sessionId);
    }

    const token = { epoch: this.epoch };
    this.pendingRequests += 1;
    if (this.removalSupported) {
      this.publishWaiting(this.pendingRequests === 1 ? "info" : "none");
    }
    return token;
  }

  /** Release one slot. Stale tokens from a replaced session are ignored. */
  finishRequest(token: PresenceRequestToken): void {
    if (token.epoch !== this.epoch || this.pendingRequests === 0) return;
    this.pendingRequests -= 1;
    if (this.pendingRequests === 0) {
      this.withdraw();
    } else if (this.removalSupported) {
      this.publishWaiting("none");
    }
  }

  private readSessionId(ctx: ExtensionContext): string | null {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      return safePresenceText(sessionId) ? sessionId : null;
    } catch {
      return null;
    }
  }

  private resetSession(sessionId: string | null): void {
    this.epoch += 1;
    this.sessionId = sessionId;
    this.lastGeneration = Math.max(Date.now(), this.lastGeneration + 1);
    this.generation = this.lastGeneration;
    this.sequence = 0;
    this.pendingRequests = 0;
    this.published = false;
    this.removalSupported = sessionId !== null && sessionId === this.advertisedSessionId;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private publishWaiting(attention: "info" | "none"): void {
    if (!this.sessionId || !this.removalSupported || this.pendingRequests === 0) return;
    this.published = true;
    this.emit(PRESENCE_UPDATE_EVENT, {
      version: 1,
      sessionId: this.sessionId,
      generation: this.generation,
      sequence: this.nextSequence(),
      source: { id: PRESENCE_SOURCE_ID, label: PRESENCE_SOURCE_LABEL, kind: "interaction" },
      state: "waiting",
      counts: {
        active: this.pendingRequests,
        completed: 0,
        failed: 0,
        total: this.pendingRequests,
      },
      attention,
    });
  }

  private withdraw(): void {
    if (!this.published || !this.sessionId) return;
    this.published = false;
    this.emit(PRESENCE_REMOVE_EVENT, {
      version: 1,
      sessionId: this.sessionId,
      generation: this.generation,
      sequence: this.nextSequence(),
      source: { id: PRESENCE_SOURCE_ID },
    });
  }

  private emit(event: string, payload: unknown): void {
    try {
      this.pi.events.emit(event, payload);
    } catch {
      // Presence is best-effort and cannot own questionnaire success or failure.
    }
  }
}
