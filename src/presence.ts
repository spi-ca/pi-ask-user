// Optional, process-local presence producer.
//
// Publishes `pi-presence:update:v1` / `pi-presence:remove:v1` on the in-process
// event bus so an installed protocol-compatible consumer can surface a
// "Pi needs your input" state. Presence is observer output only: every emit is
// best-effort and can never fail or delay the questionnaire itself.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PRESENCE_UPDATE_EVENT = "pi-presence:update:v1";
export const PRESENCE_REMOVE_EVENT = "pi-presence:remove:v1";
export const PRESENCE_READY_EVENT = "pi-presence:ready:v1";
export const PRESENCE_REMOVE_CAPABILITY = "presence-remove-v1";
export const PRESENCE_SOURCE_ID = "ask-user";
export const PRESENCE_SOURCE_LABEL = "Pi needs your input";
export const MAX_PRESENCE_TEXT = 96;
export const MAX_PRESENCE_CAPABILITIES = 16;

export interface PresenceRequestToken {
  epoch: number;
}

/** Canonical v1 ready DTO, copied from untrusted event-bus input. */
export interface PresenceReadyAdvertisement {
  readonly version: 1;
  readonly sessionId: string;
  readonly consumer?: {
    readonly id: string;
    readonly capabilities: readonly string[];
  };
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

/** Canonical v1 plain objects permit the ordinary and null prototypes. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** Copy only own data fields before inspecting their values again. */
function snapshotOwnDataFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (
    !keys.every((key) => typeof key === "string" && allowed.includes(key)) ||
    !required.every((key) => keys.includes(key))
  ) {
    return null;
  }

  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

/** Copy the canonical bounded dense list without indexed reads or deduplication. */
function snapshotCapabilities(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_PRESENCE_CAPABILITIES
  ) {
    return null;
  }

  const length = lengthDescriptor.value;
  if (
    keys.length !== length + 1 ||
    !keys.every(
      (key) => key === "length" || (typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length),
    )
  ) {
    return null;
  }

  const capabilities: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !safePresenceText(descriptor.value)) return null;
    capabilities.push(descriptor.value);
  }
  return Object.freeze(capabilities);
}

/**
 * Total parser for canonical v1 ready traffic. The return value is a frozen,
 * owned DTO, so subsequent Proxy traps or mutation cannot change its meaning.
 */
export function parsePresenceReady(payload: unknown): PresenceReadyAdvertisement | null {
  try {
    const root = snapshotOwnDataFields(payload, ["version", "sessionId", "consumer"], ["version", "sessionId"]);
    if (!root || root.version !== 1 || !safePresenceText(root.sessionId)) return null;
    if (!Object.hasOwn(root, "consumer")) return Object.freeze({ version: 1, sessionId: root.sessionId });

    const consumer = snapshotOwnDataFields(root.consumer, ["id", "capabilities"], ["id", "capabilities"]);
    if (!consumer || !safePresenceText(consumer.id)) return null;
    const capabilities = snapshotCapabilities(consumer.capabilities);
    if (!capabilities) return null;
    return Object.freeze({
      version: 1,
      sessionId: root.sessionId,
      consumer: Object.freeze({ id: consumer.id, capabilities }),
    });
  } catch {
    return null;
  }
}

/** Optional, process-local presence producer. Questionnaire authority stays in the tool. */
export class AskUserPresence {
  private sessionId: string | null = null;
  private advertisedSessionId: string | null = null;
  private discoveryPayload: object | null = null;
  private selfDeliveryPayload: object | null = null;
  private discoveryInFlight = false;
  private handlingReady = false;
  private generation = 0;
  private lastGeneration = 0;
  private sequence = 0;
  private pendingRequests = 0;
  private epoch = 0;
  private removalSupported = false;
  private published = false;

  constructor(private readonly pi: ExtensionAPI) {}

  /** Process canonical consumer advertisements and consumer-less replay requests. */
  handleReady(payload: unknown): void {
    // The producer receives its own discovery event on buses that broadcast to
    // every listener. Suppress that exact object only until emit returns; a later
    // re-emission of it is a valid request to replay retained waiting state.
    if (payload === this.selfDeliveryPayload || this.handlingReady) return;

    this.handlingReady = true;
    try {
      const ready = parsePresenceReady(payload);
      if (!ready || (this.sessionId !== null && ready.sessionId !== this.sessionId)) return;

      if (!ready.consumer) {
        // Advertisements are passive. A separate consumer-less request is the
        // canonical replay trigger; the guard bounds synchronous re-emission to
        // one fresh update for this incoming request.
        if (ready.sessionId === this.sessionId && this.pendingRequests > 0) this.publishWaiting("none");
        return;
      }

      if (!ready.consumer.capabilities.includes(PRESENCE_REMOVE_CAPABILITY)) return;
      this.advertisedSessionId = ready.sessionId;
      if (ready.sessionId !== this.sessionId) return;
      this.removalSupported = true;
    } catch {
      // Event-bus payloads are advisory and must never interrupt the questionnaire.
    } finally {
      this.handlingReady = false;
    }
  }

  startSession(ctx: ExtensionContext): void {
    const sessionId = this.readSessionId(ctx);
    this.resetSession(sessionId);
    this.requestDiscovery();
  }

  stopSession(): void {
    this.withdraw();
    this.epoch += 1;
    this.sessionId = null;
    this.discoveryPayload = null;
    this.selfDeliveryPayload = null;
    this.discoveryInFlight = false;
    this.removalSupported = false;
    this.pendingRequests = 0;
  }

  /** Claim one pending-input slot. The returned token fences a later finish. */
  beginRequest(ctx: ExtensionContext): PresenceRequestToken {
    const sessionId = this.readSessionId(ctx);
    if (sessionId !== this.sessionId) {
      this.withdraw();
      this.resetSession(sessionId);
      // Discover before incrementing so a synchronous consumer response can
      // enable this request's normal first (`info`) waiting update.
      this.requestDiscovery();
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
    this.discoveryPayload = null;
    this.selfDeliveryPayload = null;
    this.discoveryInFlight = false;
    if (sessionId !== this.advertisedSessionId) this.advertisedSessionId = null;
    this.removalSupported = sessionId !== null && sessionId === this.advertisedSessionId;
  }

  /** Ask consumers to advertise once per valid session, without impersonating one. */
  private requestDiscovery(): void {
    if (!this.sessionId || this.discoveryPayload || this.discoveryInFlight) return;
    const discovery = Object.freeze({ version: 1 as const, sessionId: this.sessionId });
    this.discoveryPayload = discovery;
    this.selfDeliveryPayload = discovery;
    this.discoveryInFlight = true;
    try {
      this.emit(PRESENCE_READY_EVENT, discovery);
    } finally {
      this.selfDeliveryPayload = null;
      this.discoveryInFlight = false;
    }
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
