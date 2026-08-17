// Deterministic consumer-side V1 fixtures. These are local protocol profiles,
// not imports of or adapters for a live consumer implementation.

export interface CanonicalConsumerProfile {
  readonly name: string;
  readonly id: string;
  readonly capabilities: readonly string[];
}

/** Generic cmux-style V1 consumer: remove support is intentionally absent. */
export const CMUX_V1_CONSUMER: CanonicalConsumerProfile = Object.freeze({
  name: "cmux-style V1",
  id: "pi-cmux-presence",
  capabilities: Object.freeze([]),
});

/** Herdr advertises its optional V1 removal support. */
export const HERDR_V1_CONSUMER: CanonicalConsumerProfile = Object.freeze({
  name: "Herdr-style V1",
  id: "herdr",
  capabilities: Object.freeze(["presence-remove-v1"]),
});

export const CANONICAL_CONSUMER_PROFILES = Object.freeze([CMUX_V1_CONSUMER, HERDR_V1_CONSUMER]);

export function readyAdvertisement(profile: CanonicalConsumerProfile, sessionId: string): unknown {
  return {
    version: 1,
    sessionId,
    consumer: { id: profile.id, capabilities: [...profile.capabilities] },
  };
}

export function readyReplayRequest(sessionId: string): unknown {
  return { version: 1, sessionId };
}

function hasExactDataKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || !ownKeys.every((key) => typeof key === "string" && keys.includes(key))) {
    return false;
  }
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in (descriptor ?? {});
  });
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeV1Text(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > 96) return false;
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

/** Strict consumer-side acceptance rule for producer V1 waiting updates. */
export function isStrictWaitingUpdate(payload: unknown): boolean {
  if (
    !hasExactDataKeys(payload, [
      "version",
      "sessionId",
      "generation",
      "sequence",
      "source",
      "state",
      "counts",
      "attention",
    ]) ||
    payload.version !== 1 ||
    !isSafeV1Text(payload.sessionId) ||
    !isPositiveSafeInteger(payload.generation) ||
    !isPositiveSafeInteger(payload.sequence) ||
    payload.state !== "waiting" ||
    (payload.attention !== "info" && payload.attention !== "none")
  ) {
    return false;
  }

  const { source, counts } = payload;
  return (
    hasExactDataKeys(source, ["id", "label", "kind"]) &&
    source.id === "ask-user" &&
    source.label === "Pi needs your input" &&
    source.kind === "interaction" &&
    hasExactDataKeys(counts, ["active", "completed", "failed", "total"]) &&
    isPositiveSafeInteger(counts.active) &&
    counts.completed === 0 &&
    counts.failed === 0 &&
    counts.total === counts.active
  );
}

/** Strict consumer-side acceptance rule for producer V1 removals. */
export function isStrictRemoval(payload: unknown): boolean {
  if (
    !hasExactDataKeys(payload, ["version", "sessionId", "generation", "sequence", "source"]) ||
    payload.version !== 1 ||
    !isSafeV1Text(payload.sessionId) ||
    !isPositiveSafeInteger(payload.generation) ||
    !isPositiveSafeInteger(payload.sequence)
  ) {
    return false;
  }
  return hasExactDataKeys(payload.source, ["id"]) && payload.source.id === "ask-user";
}

/** The strict schemas above leave no room for question or answer fields. */
export function isPrivacySafePresencePayload(payload: unknown): boolean {
  const serialized = JSON.stringify(payload);
  return !["prompt", "options", "answers", "selections", "defaultValues", "filter", "custom", "value"].some((field) =>
    serialized.includes(`"${field}"`),
  );
}
