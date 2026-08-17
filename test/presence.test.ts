import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AskUserPresence,
  MAX_PRESENCE_CAPABILITIES,
  MAX_PRESENCE_TEXT,
  PRESENCE_READY_EVENT,
  PRESENCE_REMOVE_CAPABILITY,
  PRESENCE_REMOVE_EVENT,
  PRESENCE_SOURCE_ID,
  PRESENCE_UPDATE_EVENT,
  parsePresenceReady,
  safePresenceText,
} from "../src/presence.ts";

interface PresenceEventPayload {
  version?: number;
  sessionId?: string;
  consumer?: unknown;
  state?: string;
  attention?: string;
  source?: { id?: string; label?: string; kind?: string };
  counts?: { active?: number; completed?: number; failed?: number; total?: number };
  sequence?: number;
  generation?: number;
}

interface Emitted {
  event: string;
  payload: PresenceEventPayload;
}

function fakePi(onEmit?: (event: string, payload: unknown) => void) {
  const emitted: Emitted[] = [];
  const pi = {
    events: {
      emit(event: string, payload: unknown) {
        emitted.push({ event, payload: payload as PresenceEventPayload });
        onEmit?.(event, payload);
      },
      on() {},
    },
    on() {},
  } as unknown as ExtensionAPI;
  return { pi, emitted };
}

function fakeCtx(sessionId: string | (() => string)): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => (typeof sessionId === "function" ? sessionId() : sessionId),
    },
  } as unknown as ExtensionContext;
}

function readyPayload(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    sessionId,
    consumer: { id: "pi-cmux-presence", capabilities: [PRESENCE_REMOVE_CAPABILITY] },
    ...overrides,
  };
}

function presenceEvents(emitted: Emitted[]): Emitted[] {
  return emitted.filter((entry) => entry.event !== PRESENCE_READY_EVENT);
}

function discoveryEvents(emitted: Emitted[]): Emitted[] {
  return emitted.filter((entry) => entry.event === PRESENCE_READY_EVENT);
}

/** Mirrors a generic consumer: only a JSON-shaped, exact discovery is accepted. */
function isStrictDiscovery(payload: unknown): payload is { version: 1; sessionId: string } {
  if (!payload || typeof payload !== "object" || Object.getPrototypeOf(payload) !== Object.prototype) return false;
  if (
    Reflect.ownKeys(payload).length !== 2 ||
    !Reflect.ownKeys(payload).every((key) => key === "version" || key === "sessionId")
  ) {
    return false;
  }
  for (const key of ["version", "sessionId"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(payload, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return (
    Object.getOwnPropertyDescriptor(payload, "version")!.value === 1 &&
    typeof Object.getOwnPropertyDescriptor(payload, "sessionId")!.value === "string"
  );
}

test("safePresenceText accepts short clean text and rejects unsafe text", () => {
  expect(safePresenceText("session-1")).toBe(true);
  expect(safePresenceText("한글 세션")).toBe(true);
  expect(safePresenceText("")).toBe(false);
  expect(safePresenceText(42)).toBe(false);
  expect(safePresenceText("with\nnewline")).toBe(false);
  expect(safePresenceText("with\u202ebidi")).toBe(false);
  expect(safePresenceText("a".repeat(MAX_PRESENCE_TEXT))).toBe(true);
  expect(safePresenceText("a".repeat(MAX_PRESENCE_TEXT + 1))).toBe(false);
});

test("canonical ready parsing accepts null-prototype objects and duplicate capabilities", () => {
  const consumer = Object.create(null) as { id: string; capabilities: string[] };
  consumer.id = "canonical-consumer";
  consumer.capabilities = [PRESENCE_REMOVE_CAPABILITY, PRESENCE_REMOVE_CAPABILITY];
  const ready = Object.create(null) as { version: 1; sessionId: string; consumer: typeof consumer };
  ready.version = 1;
  ready.sessionId = "s1";
  ready.consumer = consumer;

  const parsed = parsePresenceReady(ready);
  expect(parsed).toEqual(ready);
  expect(parsed).not.toBe(ready);
  expect(parsed?.consumer).not.toBe(consumer);
  expect(parsed?.consumer?.capabilities).not.toBe(consumer.capabilities);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed?.consumer)).toBe(true);
  expect(Object.isFrozen(parsed?.consumer?.capabilities)).toBe(true);
  expect(parsePresenceReady(Object.assign(Object.create(null), { version: 1, sessionId: "s1" }))).toEqual({
    version: 1,
    sessionId: "s1",
  });
});

test("ready parsing snapshots Proxy-backed capability data before later mutation", () => {
  const capabilities = [PRESENCE_REMOVE_CAPABILITY];
  const guardedCapabilities = new Proxy(capabilities, {
    get() {
      throw new Error("indexed or inherited reads are forbidden");
    },
  });
  const guardedConsumer = new Proxy(
    { id: "proxy-consumer", capabilities: guardedCapabilities },
    {
      get() {
        throw new Error("consumer properties must come from descriptors");
      },
    },
  );

  const parsed = parsePresenceReady({ version: 1, sessionId: "s1", consumer: guardedConsumer });
  capabilities[0] = "changed-after-validation";

  expect(parsed).toEqual({
    version: 1,
    sessionId: "s1",
    consumer: { id: "proxy-consumer", capabilities: [PRESENCE_REMOVE_CAPABILITY] },
  });
  expect(Object.isFrozen(parsed?.consumer?.capabilities)).toBe(true);
});

test("session start emits one consumer-less discovery request", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);

  presence.startSession(fakeCtx("s1"));

  expect(discoveryEvents(emitted)).toHaveLength(1);
  const discovery = discoveryEvents(emitted)[0]!.payload;
  expect(isStrictDiscovery(discovery)).toBe(true);
  expect(discovery).toEqual({ version: 1, sessionId: "s1" });
  expect(Reflect.ownKeys(discovery)).toEqual(["version", "sessionId"]);
});

test("no update or removal is published without a valid consumer advertisement", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  const token = presence.beginRequest(fakeCtx("s1"));
  presence.finishRequest(token);
  expect(presenceEvents(emitted)).toEqual([]);
});

test("a generic Herdr consumer enables a waiting update and withdrawal", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1", { consumer: { id: "herdr", capabilities: [PRESENCE_REMOVE_CAPABILITY] } }));

  const token = presence.beginRequest(fakeCtx("s1"));
  const output = presenceEvents(emitted);
  expect(output).toHaveLength(1);
  expect(output[0]!.event).toBe(PRESENCE_UPDATE_EVENT);
  expect(output[0]!.payload.state).toBe("waiting");
  expect(output[0]!.payload.attention).toBe("info");
  expect(output[0]!.payload.source?.id).toBe(PRESENCE_SOURCE_ID);
  expect(output[0]!.payload.counts).toEqual({ active: 1, completed: 0, failed: 0, total: 1 });

  presence.finishRequest(token);
  expect(presenceEvents(emitted)).toHaveLength(2);
  expect(presenceEvents(emitted)[1]!.event).toBe(PRESENCE_REMOVE_EVENT);
  expect(presenceEvents(emitted)[1]!.payload.source).toEqual({ id: PRESENCE_SOURCE_ID });
});

test("a valid consumer without the optional remove capability enables update and withdrawal", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1", { consumer: { id: "legacy-consumer", capabilities: [] } }));

  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));

  expect(presenceEvents(emitted).map((entry) => entry.event)).toEqual([PRESENCE_UPDATE_EVENT, PRESENCE_REMOVE_EVENT]);
});

test("the existing pi-cmux-presence advertisement remains compatible", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1"));

  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));
  expect(presenceEvents(emitted).map((entry) => entry.event)).toEqual([PRESENCE_UPDATE_EVENT, PRESENCE_REMOVE_EVENT]);
});

test("concurrent requests only raise attention once and withdraw at zero", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1"));

  const first = presence.beginRequest(fakeCtx("s1"));
  const second = presence.beginRequest(fakeCtx("s1"));
  let output = presenceEvents(emitted);
  expect(output[0]!.payload.attention).toBe("info");
  expect(output[1]!.payload.attention).toBe("none");
  expect(output[1]!.payload.counts?.active).toBe(2);

  presence.finishRequest(first);
  output = presenceEvents(emitted);
  expect(output[2]!.event).toBe(PRESENCE_UPDATE_EVENT);
  expect(output[2]!.payload.counts?.active).toBe(1);

  presence.finishRequest(second);
  expect(presenceEvents(emitted)[3]!.event).toBe(PRESENCE_REMOVE_EVENT);
});

test("sequence numbers increase monotonically within a session", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1"));

  const first = presence.beginRequest(fakeCtx("s1"));
  const second = presence.beginRequest(fakeCtx("s1"));
  presence.finishRequest(first);
  presence.finishRequest(second);

  const output = presenceEvents(emitted);
  expect(output.map((entry) => entry.payload.sequence)).toEqual([1, 2, 3, 4]);
  expect(new Set(output.map((entry) => entry.payload.generation)).size).toBe(1);
});

test("strict ready validation rejects huge, sparse, extra, getter, and inherited payloads", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));

  const sparse = [PRESENCE_REMOVE_CAPABILITY] as string[];
  sparse.length = 2;
  const getterPayload = {
    version: 1,
    sessionId: "s1",
    consumer: { id: "herdr", capabilities: [PRESENCE_REMOVE_CAPABILITY] },
  };
  Object.defineProperty(getterPayload, "sessionId", { enumerable: true, get: () => "s1" });
  const inherited = Object.create({
    version: 1,
    sessionId: "s1",
    consumer: { id: "herdr", capabilities: [PRESENCE_REMOVE_CAPABILITY] },
  });

  for (const payload of [
    readyPayload("x".repeat(MAX_PRESENCE_TEXT + 1)),
    readyPayload("s1", {
      consumer: { id: "x".repeat(MAX_PRESENCE_TEXT + 1), capabilities: [PRESENCE_REMOVE_CAPABILITY] },
    }),
    readyPayload("s1", { consumer: { id: "herdr", capabilities: sparse } }),
    readyPayload("s1", {
      consumer: {
        id: "herdr",
        capabilities: Array.from({ length: MAX_PRESENCE_CAPABILITIES + 1 }, (_, index) => `capability-${index}`),
      },
    }),
    readyPayload("s1", { extra: true }),
    getterPayload,
    inherited,
  ]) {
    presence.handleReady(payload);
  }

  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));
  expect(presenceEvents(emitted)).toEqual([]);
});

test("malformed and foreign ready payloads are ignored", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));

  presence.handleReady(undefined);
  presence.handleReady({
    version: 2,
    sessionId: "s1",
    consumer: { id: "herdr", capabilities: [PRESENCE_REMOVE_CAPABILITY] },
  });
  presence.handleReady(readyPayload("s1", { consumer: { id: "herdr" } }));
  presence.handleReady(
    readyPayload("s1", { consumer: { id: "bad\nsession", capabilities: [PRESENCE_REMOVE_CAPABILITY] } }),
  );
  presence.handleReady(readyPayload("s1", { requestId: "bad\nrequest" }));
  presence.handleReady(readyPayload("bad\nsession"));
  presence.handleReady(readyPayload("s2"));

  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));
  expect(presenceEvents(emitted)).toEqual([]);
});

test("a late consumer advertisement and request publish the pending state once", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));

  const token = presence.beginRequest(fakeCtx("s1"));
  expect(presenceEvents(emitted)).toHaveLength(0);

  presence.handleReady(readyPayload("s1"));
  expect(presenceEvents(emitted)).toHaveLength(0);
  presence.handleReady({ version: 1, sessionId: "s1" });
  expect(presenceEvents(emitted)).toHaveLength(1);
  expect(presenceEvents(emitted)[0]!.payload.attention).toBe("none");

  presence.finishRequest(token);
  expect(presenceEvents(emitted)[1]!.event).toBe(PRESENCE_REMOVE_EVENT);
});

test("a discovery object re-emitted after emit replays the pending state once", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1"));
  const token = presence.beginRequest(fakeCtx("s1"));
  const ownDiscovery = discoveryEvents(emitted)[0]!.payload;

  presence.handleReady(ownDiscovery);
  presence.handleReady({ version: 1, sessionId: "s1" });
  presence.handleReady({ version: 1, sessionId: "s1" });

  const output = presenceEvents(emitted);
  expect(output.map((entry) => entry.event)).toEqual([
    PRESENCE_UPDATE_EVENT,
    PRESENCE_UPDATE_EVENT,
    PRESENCE_UPDATE_EVENT,
    PRESENCE_UPDATE_EVENT,
  ]);
  expect(output.map((entry) => entry.payload.sequence)).toEqual([1, 2, 3, 4]);
  expect(output.map((entry) => entry.payload.attention)).toEqual(["info", "none", "none", "none"]);

  presence.finishRequest(token);
  expect(presenceEvents(emitted).at(-1)!.event).toBe(PRESENCE_REMOVE_EVENT);
});

test("a replayed ready request cannot synchronously recurse", () => {
  let presence: AskUserPresence;
  const { pi, emitted } = fakePi((event, payload) => {
    if (event === PRESENCE_UPDATE_EVENT && (payload as PresenceEventPayload).sequence === 2) {
      presence.handleReady({ version: 1, sessionId: "s1" });
    }
  });
  presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1"));
  const token = presence.beginRequest(fakeCtx("s1"));

  presence.handleReady({ version: 1, sessionId: "s1" });
  expect(presenceEvents(emitted).map((entry) => entry.payload.sequence)).toEqual([1, 2]);

  presence.finishRequest(token);
});

test("a ready advertisement with an extra field is ignored", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));

  presence.handleReady(readyPayload("s1", { requestId: "obsolete-request-id" }));
  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));

  expect(presenceEvents(emitted)).toEqual([]);
});

test("producer-first discovery accepts a synchronous advertisement response", () => {
  let presence: AskUserPresence;
  const { pi, emitted } = fakePi((event, payload) => {
    if (event !== PRESENCE_READY_EVENT || !isStrictDiscovery(payload)) return;
    presence.handleReady({
      version: 1,
      sessionId: payload.sessionId,
      consumer: { id: "herdr", capabilities: [PRESENCE_REMOVE_CAPABILITY] },
    });
  });
  presence = new AskUserPresence(pi);

  presence.startSession(fakeCtx("s1"));
  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));

  expect(discoveryEvents(emitted)).toHaveLength(1);
  expect(presenceEvents(emitted).map((entry) => entry.event)).toEqual([PRESENCE_UPDATE_EVENT, PRESENCE_REMOVE_EVENT]);
});

test("multiple consumer advertisements stay passive until a consumer-less request replays once", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  const token = presence.beginRequest(fakeCtx("s1"));

  presence.handleReady(readyPayload("s1", { consumer: { id: "herdr", capabilities: [PRESENCE_REMOVE_CAPABILITY] } }));
  presence.handleReady(
    readyPayload("s1", {
      consumer: { id: "another-consumer", capabilities: ["other-v1", PRESENCE_REMOVE_CAPABILITY] },
    }),
  );
  expect(presenceEvents(emitted)).toEqual([]);

  presence.handleReady({ version: 1, sessionId: "s1" });
  expect(presenceEvents(emitted).map((entry) => entry.event)).toEqual([PRESENCE_UPDATE_EVENT]);
  presence.finishRequest(token);
  expect(presenceEvents(emitted).map((entry) => entry.event)).toEqual([PRESENCE_UPDATE_EVENT, PRESENCE_REMOVE_EVENT]);
});

test("consumer-first advertisement remains active after session start", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.handleReady(readyPayload("s1", { consumer: { id: "herdr", capabilities: [PRESENCE_REMOVE_CAPABILITY] } }));

  presence.startSession(fakeCtx("s1"));
  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));

  expect(discoveryEvents(emitted)).toHaveLength(1);
  expect(presenceEvents(emitted).map((entry) => entry.event)).toEqual([PRESENCE_UPDATE_EVENT, PRESENCE_REMOVE_EVENT]);
});

test("own discovery and synchronous replayed responses do not recurse or republish", () => {
  let presence: AskUserPresence;
  const { pi, emitted } = fakePi((event, payload) => {
    if (event !== PRESENCE_READY_EVENT) return;
    // Event buses can deliver the producer's request to its own listener.
    presence.handleReady(payload);
    if (!isStrictDiscovery(payload)) return;
    const response = {
      version: 1,
      sessionId: payload.sessionId,
      consumer: { id: "herdr", capabilities: [PRESENCE_REMOVE_CAPABILITY] },
    };
    // A consumer may respond before emit returns and replay that response.
    presence.handleReady(response);
    presence.handleReady(response);
  });
  presence = new AskUserPresence(pi);

  presence.startSession(fakeCtx("s1"));
  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));

  expect(discoveryEvents(emitted)).toHaveLength(1);
  expect(presenceEvents(emitted).map((entry) => entry.event)).toEqual([PRESENCE_UPDATE_EVENT, PRESENCE_REMOVE_EVENT]);
});

test("session shutdown withdraws presence and stale tokens are ignored", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1"));

  const token = presence.beginRequest(fakeCtx("s1"));
  presence.stopSession();
  expect(presenceEvents(emitted)[1]!.event).toBe(PRESENCE_REMOVE_EVENT);

  presence.finishRequest(token);
  expect(presenceEvents(emitted)).toHaveLength(2);
});

test("a session change discovers s2 before its synchronous ready response updates and removes it", () => {
  let presence: AskUserPresence;
  const { pi, emitted } = fakePi((event, payload) => {
    if (event !== PRESENCE_READY_EVENT || !isStrictDiscovery(payload)) return;
    presence.handleReady(
      readyPayload(payload.sessionId, {
        consumer: { id: `consumer-${payload.sessionId}`, capabilities: [PRESENCE_REMOVE_CAPABILITY] },
      }),
    );
  });
  presence = new AskUserPresence(pi);

  presence.startSession(fakeCtx("s1"));
  const stale = presence.beginRequest(fakeCtx("s1"));
  const fresh = presence.beginRequest(fakeCtx("s2"));

  const discoveries = discoveryEvents(emitted).map((entry) => entry.payload.sessionId);
  expect(discoveries).toEqual(["s1", "s2"]);
  const output = presenceEvents(emitted);
  expect(output.map((entry) => entry.event)).toEqual([
    PRESENCE_UPDATE_EVENT,
    PRESENCE_REMOVE_EVENT,
    PRESENCE_UPDATE_EVENT,
  ]);
  expect(output[2]!.payload.sessionId).toBe("s2");
  expect(output[2]!.payload.attention).toBe("info");

  presence.finishRequest(stale);
  presence.finishRequest(fresh);
  expect(presenceEvents(emitted).at(-1)!.event).toBe(PRESENCE_REMOVE_EVENT);
  expect(presenceEvents(emitted).at(-1)!.payload.sessionId).toBe("s2");
});

test("an unsafe session id disables presence output", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("bad\nsession"));
  presence.handleReady(readyPayload("bad\nsession"));

  presence.finishRequest(presence.beginRequest(fakeCtx("bad\nsession")));
  expect(emitted).toEqual([]);
});

test("a throwing session manager does not propagate", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  const throwing = fakeCtx(() => {
    throw new Error("session lookup failed");
  });

  expect(() => presence.startSession(throwing)).not.toThrow();
  expect(() => presence.finishRequest(presence.beginRequest(throwing))).not.toThrow();
  expect(emitted).toEqual([]);
});

test("a throwing event bus does not propagate", () => {
  const { pi } = fakePi(() => {
    throw new Error("event bus down");
  });
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));

  expect(() => presence.handleReady(readyPayload("s1"))).not.toThrow();
  expect(() => presence.finishRequest(presence.beginRequest(fakeCtx("s1")))).not.toThrow();
});

test("presence payloads never carry questionnaire content", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1"));
  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));

  const serialized = JSON.stringify(emitted);
  expect(serialized).not.toContain("prompt");
  expect(serialized).not.toContain("options");
  expect(serialized).not.toContain("answers");
  for (const field of ["custom", "filter", "skipped", "selections", "defaultValues", "value"]) {
    expect(serialized).not.toContain(`"${field}"`);
  }
  expect(serialized.match(/"label"/g)).toHaveLength(1);
  expect(serialized).toContain('"label":"Pi needs your input"');
});
