import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPresenceProducer, EVENT_NAMES, MAX_INTEGER } from "@pi/presence";
import { AskUserPresence } from "../src/presence.ts";
import {
  attachV2Consumer,
  createEventBus,
  QUESTIONNAIRE_SENTINELS,
  serializedPayloadsArePrivate,
} from "./helpers/presence-consumer.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fakeCtx(sessionId: string | (() => string)): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => (typeof sessionId === "function" ? sessionId() : sessionId),
    },
  } as unknown as ExtensionContext;
}

function fakePi(bus: ReturnType<typeof createEventBus>): ExtensionAPI {
  return {
    events: {
      emit(eventName: string, payload: unknown) {
        bus.emit(eventName, payload);
      },
      on() {},
    },
    on() {},
  } as unknown as ExtensionAPI;
}

function presenceEvents(bus: ReturnType<typeof createEventBus>) {
  return bus.emitted.filter(({ eventName }) => eventName === EVENT_NAMES.state || eventName === EVENT_NAMES.withdraw);
}

function start(bus: ReturnType<typeof createEventBus>) {
  const presence = new AskUserPresence(fakePi(bus));
  cleanups.push(() => presence.stopSession());
  return presence;
}

test("consumer-first V2 fanout publishes the content-free waiting state and withdrawal", () => {
  const bus = createEventBus();
  const consumer = attachV2Consumer(bus);
  cleanups.push(() => consumer.deactivate());
  const presence = start(bus);

  presence.startSession(fakeCtx("session-private"));
  presence.finishRequest(presence.beginRequest(fakeCtx("session-private")));

  expect(consumer.received).toHaveLength(2);
  expect(consumer.received[0]).toMatchObject({
    version: 2,
    generation: 1,
    sequence: 1,
    source: "interaction",
    state: "waiting",
    interaction: { kind: "ask_user", pending: 1 },
    attention: { reason: "input_required", occurrence: "new" },
  });
  expect(consumer.received[1]).toMatchObject({
    version: 2,
    generation: 1,
    sequence: 2,
    source: "interaction",
  });
  expect("state" in consumer.received[1]!).toBe(false);
  expect(Object.keys(consumer.received[1]!).sort()).toEqual([
    "generation",
    "sequence",
    "sessionEpoch",
    "source",
    "version",
  ]);
});

test("producer-first retention replays through a shared consumer handle without a new alert", () => {
  const bus = createEventBus();
  const presence = start(bus);
  presence.startSession(fakeCtx("session-private"));
  const token = presence.beginRequest(fakeCtx("session-private"));
  expect(presenceEvents(bus)).toEqual([]);

  const consumer = attachV2Consumer(bus, "pi-herdr-presence");
  cleanups.push(() => consumer.deactivate());
  expect(consumer.received).toHaveLength(1);
  expect(consumer.received[0]).toMatchObject({
    state: "waiting",
    interaction: { kind: "ask_user", pending: 1 },
    attention: { reason: "input_required", occurrence: "retained" },
  });

  presence.finishRequest(token);
  expect(consumer.received.at(-1)).toMatchObject({ source: "interaction", generation: 1, sequence: 2 });
});

test("concurrent requests increment sequences but only the lifecycle edge is new attention", () => {
  const bus = createEventBus();
  const consumer = attachV2Consumer(bus);
  cleanups.push(() => consumer.deactivate());
  const presence = start(bus);
  presence.startSession(fakeCtx("s1"));

  const first = presence.beginRequest(fakeCtx("s1"));
  const second = presence.beginRequest(fakeCtx("s1"));
  presence.finishRequest(first);
  presence.finishRequest(second);

  const states = consumer.received.filter((event) => "state" in event);
  expect(states.map((event) => event.sequence)).toEqual([1, 2, 3]);
  expect(states.map((event) => event.interaction?.pending)).toEqual([1, 2, 1]);
  expect(states.map((event) => event.attention?.occurrence)).toEqual(["new", "retained", "retained"]);
  expect(consumer.received.at(-1)).toMatchObject({ generation: 1, sequence: 4, source: "interaction" });
});

test("each interaction lifecycle uses a higher generation and resets its sequence", () => {
  const bus = createEventBus();
  const consumer = attachV2Consumer(bus);
  cleanups.push(() => consumer.deactivate());
  const presence = start(bus);
  presence.startSession(fakeCtx("s1"));

  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));
  presence.finishRequest(presence.beginRequest(fakeCtx("s1")));

  expect(consumer.received.map((event) => [event.generation, event.sequence])).toEqual([
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
  ]);
});

test("session replacement fences stale tokens, withdraws, and activates a fresh producer", () => {
  const bus = createEventBus();
  const consumer = attachV2Consumer(bus);
  cleanups.push(() => consumer.deactivate());
  const presence = start(bus);
  presence.startSession(fakeCtx("s1"));

  const stale = presence.beginRequest(fakeCtx("s1"));
  const fresh = presence.beginRequest(fakeCtx("s2"));
  presence.finishRequest(stale);
  presence.finishRequest(fresh);

  expect(consumer.received.map((event) => [event.generation, event.sequence])).toEqual([
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
  ]);
});

test("a temporary occupied source retries activation without replacing the session", () => {
  const bus = createEventBus();
  const consumer = attachV2Consumer(bus);
  cleanups.push(() => consumer.deactivate());
  const blocker = createPresenceProducer({ source: "interaction", emit: () => undefined });
  if (!blocker) throw new Error("producer creation failed");
  expect(blocker.activate()).toBe(true);
  cleanups.push(() => blocker.deactivate());
  const presence = start(bus);
  const ctx = fakeCtx("s1");

  presence.startSession(ctx);
  const first = presence.beginRequest(ctx);
  expect(presenceEvents(bus)).toEqual([]);

  expect(blocker.deactivate()).toBe(true);
  const second = presence.beginRequest(ctx);
  expect(second.epoch).toBe(first.epoch);
  presence.finishRequest(first);
  presence.finishRequest(second);

  expect(consumer.received.map((event) => [event.generation, event.sequence])).toEqual([
    [1, 1],
    [1, 2],
    [1, 3],
    [1, 4],
  ]);
  expect(consumer.received.filter((event) => "state" in event).map((event) => event.interaction?.pending)).toEqual([
    1, 2, 1,
  ]);
});

test("sequence saturation withdraws, recreates the source, and republishes pending state", () => {
  const bus = createEventBus();
  const consumer = attachV2Consumer(bus);
  cleanups.push(() => consumer.deactivate());
  const presence = start(bus);
  const ctx = fakeCtx("s1");
  presence.startSession(ctx);
  const first = presence.beginRequest(ctx);

  (presence as unknown as { sequence: number }).sequence = MAX_INTEGER - 1;
  const second = presence.beginRequest(ctx);
  presence.finishRequest(first);
  presence.finishRequest(second);

  expect(consumer.received.map((event) => [event.generation, event.sequence])).toEqual([
    [1, 1],
    [1, MAX_INTEGER],
    [1, 1],
    [1, 2],
    [1, 3],
  ]);
  const states = consumer.received.filter((event) => "state" in event);
  expect(states.map((event) => event.interaction?.pending)).toEqual([1, 2, 1]);
  expect(states.map((event) => event.attention?.occurrence)).toEqual(["new", "retained", "retained"]);
  expect(consumer.received.every((event) => event.generation <= MAX_INTEGER && event.sequence <= MAX_INTEGER)).toBe(
    true,
  );
});

test("generation saturation recreates the source and starts a valid lifecycle", () => {
  const bus = createEventBus();
  const consumer = attachV2Consumer(bus);
  cleanups.push(() => consumer.deactivate());
  const presence = start(bus);
  const ctx = fakeCtx("s1");
  presence.startSession(ctx);
  presence.finishRequest(presence.beginRequest(ctx));

  (presence as unknown as { generation: number }).generation = MAX_INTEGER;
  presence.finishRequest(presence.beginRequest(ctx));

  expect(consumer.received.map((event) => [event.generation, event.sequence])).toEqual([
    [1, 1],
    [1, 2],
    [1, 1],
    [1, 2],
  ]);
});

test("session shutdown withdraws once, deactivates, and ignores a stale completion", () => {
  const bus = createEventBus();
  const consumer = attachV2Consumer(bus);
  cleanups.push(() => consumer.deactivate());
  const presence = start(bus);
  const ctx = fakeCtx("s1");
  presence.startSession(ctx);
  const token = presence.beginRequest(ctx);
  presence.stopSession();
  presence.finishRequest(token);

  expect(consumer.received.map((event) => [event.generation, event.sequence])).toEqual([
    [1, 1],
    [1, 2],
  ]);
});

test("V2 lifecycle suppresses throwing sessionManager and getSessionId lookups", () => {
  const contexts = [
    fakeCtx(() => {
      throw new Error("session ID lookup failed");
    }),
    Object.defineProperty({}, "sessionManager", {
      get() {
        throw new Error("session manager lookup failed");
      },
    }) as ExtensionContext,
  ];

  for (const [index, ctx] of contexts.entries()) {
    const bus = createEventBus();
    const consumer = attachV2Consumer(bus, index === 0 ? "pi-cmux-presence" : "pi-herdr-presence");
    cleanups.push(() => consumer.deactivate());
    const presence = start(bus);

    expect(() => presence.startSession(ctx)).not.toThrow();
    expect(() => presence.finishRequest(presence.beginRequest(ctx))).not.toThrow();
    expect(() => presence.stopSession()).not.toThrow();
    expect(consumer.received).toHaveLength(2);
  }
});

test("throwing observer emission never affects presence callers", () => {
  const pi = {
    events: {
      emit() {
        throw new Error("observer failed");
      },
      on() {},
    },
    on() {},
  } as unknown as ExtensionAPI;
  const presence = new AskUserPresence(pi);
  cleanups.push(() => presence.stopSession());
  const ctx = fakeCtx("s1");

  expect(() => presence.startSession(ctx)).not.toThrow();
  expect(() => presence.finishRequest(presence.beginRequest(ctx))).not.toThrow();
  expect(() => presence.stopSession()).not.toThrow();
});

test("V2 payloads never contain questionnaire data, cancellation data, or a session ID", () => {
  const bus = createEventBus();
  const consumer = attachV2Consumer(bus);
  cleanups.push(() => consumer.deactivate());
  const presence = start(bus);
  presence.startSession(fakeCtx("session-id-sentinel-8d2e"));
  presence.finishRequest(presence.beginRequest(fakeCtx("session-id-sentinel-8d2e")));

  const payloads = presenceEvents(bus).map(({ payload }) => payload);
  expect(serializedPayloadsArePrivate(payloads)).toBe(true);
  for (const payload of payloads) {
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("session-id-sentinel-8d2e");
    for (const sentinel of QUESTIONNAIRE_SENTINELS) expect(serialized).not.toContain(sentinel);
  }
});

test("the V2 implementation has no legacy protocol or polling, socket, or CLI coupling", async () => {
  const source = await Bun.file(new URL("../src/presence.ts", import.meta.url)).text();
  const currentSupportText = await Promise.all(
    [
      "../src/presence.ts",
      "../src/tool.ts",
      "../README.md",
      "../CHANGELOG.md",
      "../docs/configuration.md",
      "../docs/development.md",
    ].map(async (path) => Bun.file(new URL(path, import.meta.url)).text()),
  );

  const retiredProtocol = new RegExp(
    [
      ["pi-presence:", ".*:", "v", "1"].join(""),
      ["presence-remove", "v", "1"].join("-"),
      ["parsePresence", "Ready"].join(""),
    ].join("|"),
    "i",
  );
  expect(currentSupportText.join("\n")).not.toMatch(retiredProtocol);
  expect(source).not.toMatch(/poll|socket|\bcli\b/i);
});
