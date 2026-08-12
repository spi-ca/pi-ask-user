import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AskUserPresence,
  MAX_PRESENCE_TEXT,
  PRESENCE_CONSUMER_ID,
  PRESENCE_REMOVE_CAPABILITY,
  PRESENCE_REMOVE_EVENT,
  PRESENCE_SOURCE_ID,
  PRESENCE_UPDATE_EVENT,
  safePresenceText,
} from "../src/presence.ts";

interface Emitted {
  event: string;
  payload: any;
}

function fakePi(emit?: (event: string, payload: unknown) => void) {
  const emitted: Emitted[] = [];
  const pi = {
    events: {
      emit(event: string, payload: unknown) {
        emitted.push({ event, payload });
        emit?.(event, payload);
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
    consumer: { id: PRESENCE_CONSUMER_ID, capabilities: [PRESENCE_REMOVE_CAPABILITY] },
    ...overrides,
  };
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

test("no presence is published without a matching consumer advertisement", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  const token = presence.beginRequest(fakeCtx("s1"));
  presence.finishRequest(token);
  expect(emitted).toEqual([]);
});

test("a remove-capable consumer enables a waiting update and a withdrawal", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1"));

  const token = presence.beginRequest(fakeCtx("s1"));
  expect(emitted).toHaveLength(1);
  expect(emitted[0]!.event).toBe(PRESENCE_UPDATE_EVENT);
  expect(emitted[0]!.payload.state).toBe("waiting");
  expect(emitted[0]!.payload.attention).toBe("info");
  expect(emitted[0]!.payload.source.id).toBe(PRESENCE_SOURCE_ID);
  expect(emitted[0]!.payload.counts).toEqual({ active: 1, completed: 0, failed: 0, total: 1 });

  presence.finishRequest(token);
  expect(emitted).toHaveLength(2);
  expect(emitted[1]!.event).toBe(PRESENCE_REMOVE_EVENT);
  expect(emitted[1]!.payload.source).toEqual({ id: PRESENCE_SOURCE_ID });
});

test("concurrent requests only raise attention once and withdraw at zero", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1"));

  const first = presence.beginRequest(fakeCtx("s1"));
  const second = presence.beginRequest(fakeCtx("s1"));
  expect(emitted[0]!.payload.attention).toBe("info");
  expect(emitted[1]!.payload.attention).toBe("none");
  expect(emitted[1]!.payload.counts.active).toBe(2);

  presence.finishRequest(first);
  expect(emitted[2]!.event).toBe(PRESENCE_UPDATE_EVENT);
  expect(emitted[2]!.payload.counts.active).toBe(1);

  presence.finishRequest(second);
  expect(emitted[3]!.event).toBe(PRESENCE_REMOVE_EVENT);
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

  const sequences = emitted.map((entry) => entry.payload.sequence);
  expect(sequences).toEqual([1, 2, 3, 4]);
  const generations = new Set(emitted.map((entry) => entry.payload.generation));
  expect(generations.size).toBe(1);
});

test("malformed or foreign ready payloads are ignored", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));

  presence.handleReady(undefined);
  presence.handleReady({
    version: 2,
    sessionId: "s1",
    consumer: { id: PRESENCE_CONSUMER_ID, capabilities: [PRESENCE_REMOVE_CAPABILITY] },
  });
  presence.handleReady(readyPayload("s1", { consumer: { id: "other", capabilities: [PRESENCE_REMOVE_CAPABILITY] } }));
  presence.handleReady(readyPayload("s1", { consumer: { id: PRESENCE_CONSUMER_ID, capabilities: [] } }));
  presence.handleReady(readyPayload("s1", { consumer: { id: PRESENCE_CONSUMER_ID } }));
  presence.handleReady(readyPayload("bad\nsession"));

  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));
  expect(emitted).toEqual([]);
});

test("a late advertisement publishes the already pending request", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));

  const token = presence.beginRequest(fakeCtx("s1"));
  expect(emitted).toHaveLength(0);

  presence.handleReady(readyPayload("s1"));
  expect(emitted).toHaveLength(1);
  expect(emitted[0]!.payload.attention).toBe("none");

  presence.finishRequest(token);
  expect(emitted[1]!.event).toBe(PRESENCE_REMOVE_EVENT);
});

test("an advertisement for another session does not enable output", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s2"));

  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));
  expect(emitted).toEqual([]);
});

test("session shutdown withdraws presence and stale tokens are ignored", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1"));

  const token = presence.beginRequest(fakeCtx("s1"));
  presence.stopSession();
  expect(emitted[1]!.event).toBe(PRESENCE_REMOVE_EVENT);

  presence.finishRequest(token);
  expect(emitted).toHaveLength(2);
});

test("a session id change during a request resets presence state", () => {
  const { pi, emitted } = fakePi();
  const presence = new AskUserPresence(pi);
  presence.startSession(fakeCtx("s1"));
  presence.handleReady(readyPayload("s1"));

  const stale = presence.beginRequest(fakeCtx("s1"));
  const fresh = presence.beginRequest(fakeCtx("s2"));

  presence.finishRequest(stale);
  presence.finishRequest(fresh);
  expect(emitted.filter((entry) => entry.event === PRESENCE_UPDATE_EVENT).length).toBeGreaterThan(0);
  expect(emitted.at(-1)!.event).toBe(PRESENCE_REMOVE_EVENT);
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
  // Fields added alongside skipping, filtering, and free text must stay out too.
  for (const field of ["custom", "filter", "skipped", "selections", "defaultValues", "value"]) {
    expect(serialized).not.toContain(`"${field}"`);
  }
  // The only label in a payload is the fixed source label.
  expect(serialized.match(/"label"/g)).toHaveLength(1);
  expect(serialized).toContain('"label":"Pi needs your input"');
});
