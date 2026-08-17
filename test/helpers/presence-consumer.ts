// Deterministic consumer-side V1 fixtures. These are local protocol profiles,
// not imports of or adapters for a live consumer implementation.

export interface CanonicalConsumerProfile {
  readonly name: string;
  readonly id: string;
  readonly capabilities: readonly string[];
}

/** Current `pi-cmux-presence` V1 ready advertisement, copied as a local fixture. */
export const CMUX_V1_CONSUMER: CanonicalConsumerProfile = Object.freeze({
  name: "pi-cmux-presence V1",
  id: "pi-cmux-presence",
  capabilities: Object.freeze(["cmux-status", "cmux-progress", "cmux-attention", "presence-remove-v1"]),
});

/** Current `pi-herdr-presence` V1 ready advertisement, copied as a local fixture. */
export const HERDR_V1_CONSUMER: CanonicalConsumerProfile = Object.freeze({
  name: "pi-herdr-presence V1",
  id: "pi-herdr-presence",
  capabilities: Object.freeze([
    "presence-remove-v1",
    "presence-summary-v1",
    "herdr-pane-report-agent-v1",
    "herdr-pane-report-metadata-v1",
  ]),
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

/** Unique questionnaire inputs that must never appear in a presence payload. */
export const QUESTIONNAIRE_SENTINELS = Object.freeze([
  "question-id-sentinel-8d2e",
  "question-label-sentinel-8d2e",
  "question-prompt-sentinel-8d2e",
  "option-value-sentinel-8d2e",
  "option-label-sentinel-8d2e",
  "option-description-sentinel-8d2e",
]);

/** Every serialized payload field must preserve its session ID and omit questionnaire data. */
export function isPrivacySafePresencePayload(payload: unknown, expectedSessionId: string): boolean {
  if (!payload || typeof payload !== "object" || (payload as { sessionId?: unknown }).sessionId !== expectedSessionId) {
    return false;
  }
  const serialized = JSON.stringify(payload);
  return QUESTIONNAIRE_SENTINELS.every((sentinel) => !serialized.includes(sentinel));
}
