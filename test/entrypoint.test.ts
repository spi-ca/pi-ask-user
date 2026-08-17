import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import askUser from "../index.ts";
import {
  PRESENCE_READY_EVENT,
  PRESENCE_REMOVE_CAPABILITY,
  PRESENCE_REMOVE_EVENT,
  PRESENCE_UPDATE_EVENT,
} from "../src/presence.ts";
import { CANCELLED_MESSAGE, NON_INTERACTIVE_MESSAGE, TOOL_DESCRIPTION, TOOL_LABEL, TOOL_NAME } from "../src/tool.ts";
import type { QuestionnaireResult } from "../src/types.ts";
import { fakeTheme, fakeTui } from "./helpers/fake-theme.ts";
import {
  CANONICAL_CONSUMER_PROFILES,
  isPrivacySafePresencePayload,
  isStrictRemoval,
  isStrictWaitingUpdate,
  QUESTIONNAIRE_SENTINELS,
  readyAdvertisement,
} from "./helpers/presence-consumer.ts";
import { makeQuestion } from "./helpers/question.ts";

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  executionMode: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
  renderCall: (args: unknown, theme: unknown, context: unknown) => { text?: string };
  renderResult: (
    result: { content: { type: string; text: string }[]; details?: unknown },
    options: unknown,
    theme: unknown,
    context: unknown,
  ) => { text?: string };
};

type EventListener = (payload: unknown) => void;
type LifecycleListener = (event: unknown, ctx: ExtensionContext) => void;
type CustomComponent = { focused: boolean; handleInput(data: string): void };
type CustomFactory<T> = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (result: T) => void,
) => CustomComponent;

function register() {
  const hooks: string[] = [];
  const events: string[] = [];
  const emitted: { event: string; payload: unknown }[] = [];
  const eventListeners = new Map<string, EventListener>();
  const lifecycleListeners = new Map<string, LifecycleListener>();
  const tools: RegisteredTool[] = [];
  askUser({
    on(name: string, listener: LifecycleListener) {
      hooks.push(name);
      lifecycleListeners.set(name, listener);
    },
    events: {
      on(name: string, listener: EventListener) {
        events.push(name);
        eventListeners.set(name, listener);
      },
      emit(event: string, payload: unknown) {
        emitted.push({ event, payload });
      },
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  return { hooks, events, emitted, eventListeners, lifecycleListeners, tool: tools[0]!, tools };
}

/**
 * Context double whose `ui.custom` drives the component with scripted keys.
 *
 * Like real Pi, the factory runs synchronously but the promise only resolves
 * once `done` fires, so the tool can register its abort handler in between.
 */
function tuiContext(script: string[], sessionId = "s1", deferFactory = false): ExtensionContext {
  return {
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      custom<T>(factory: CustomFactory<T>): Promise<T> {
        let settle: ((result: T) => void) | undefined;
        const settled = new Promise<T>((resolve) => {
          settle = resolve;
        });
        const mount = () => {
          const component = factory(fakeTui(), fakeTheme(), {}, (result) => settle?.(result));
          component.focused = true;
          queueMicrotask(() => {
            for (const key of script) component.handleInput(key);
          });
        };
        if (deferFactory) queueMicrotask(mount);
        else mount();
        return settled;
      },
    },
  } as unknown as ExtensionContext;
}

function trackedAbortSignal(): { signal: AbortSignal; listenerCount: () => number } {
  const listeners = new Set<unknown>();
  return {
    signal: {
      aborted: false,
      addEventListener(type: string, listener: unknown) {
        if (type === "abort") listeners.add(listener);
      },
      removeEventListener(type: string, listener: unknown) {
        if (type === "abort") listeners.delete(listener);
      },
    } as AbortSignal,
    listenerCount: () => listeners.size,
  };
}

function presenceEvents(registration: ReturnType<typeof register>) {
  return registration.emitted.filter(({ event }) => event === PRESENCE_UPDATE_EVENT || event === PRESENCE_REMOVE_EVENT);
}

function activatePresence(registration: ReturnType<typeof register>, ctx: ExtensionContext): void {
  registration.lifecycleListeners.get("session_start")?.({}, ctx);
  const discovery = registration.emitted.find(({ event }) => event === PRESENCE_READY_EVENT);
  expect(discovery?.payload).toEqual({ version: 1, sessionId: "s1" });

  registration.eventListeners.get(PRESENCE_READY_EVENT)?.({
    version: 1,
    sessionId: "s1",
    consumer: { id: "test-consumer", capabilities: [PRESENCE_REMOVE_CAPABILITY] },
  });
}

function factoryThrowingContext(): ExtensionContext {
  return {
    mode: "tui",
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      custom<T>(factory: CustomFactory<T>): Promise<T> {
        factory(fakeTui(), fakeTheme(), new Proxy({}, { get: () => throwFactoryError() }), () => undefined);
        throw new Error("factory unexpectedly returned");
      },
    },
  } as unknown as ExtensionContext;
}

function throwFactoryError(): never {
  throw new Error("factory failed");
}

const SINGLE_QUESTION = {
  questions: [
    {
      id: "lang",
      label: "Language",
      prompt: "Pick one",
      options: [
        { value: "ko", label: "Korean" },
        { value: "en", label: "English" },
      ],
    },
  ],
};

const PRIVACY_SENTINEL_QUESTION = {
  questions: [
    {
      id: QUESTIONNAIRE_SENTINELS[0],
      label: QUESTIONNAIRE_SENTINELS[1],
      prompt: QUESTIONNAIRE_SENTINELS[2],
      options: [
        {
          value: QUESTIONNAIRE_SENTINELS[3],
          label: QUESTIONNAIRE_SENTINELS[4],
          description: QUESTIONNAIRE_SENTINELS[5],
        },
      ],
    },
  ],
};

test("the entrypoint registers one tool plus lifecycle and presence observers", () => {
  const { hooks, events, tools, tool } = register();

  expect(tools).toHaveLength(1);
  expect(tool.name).toBe(TOOL_NAME);
  expect(tool.label).toBe(TOOL_LABEL);
  expect(tool.description).toBe(TOOL_DESCRIPTION);
  expect(tool.executionMode).toBe("sequential");
  expect(hooks).toEqual(["session_start", "session_shutdown"]);
  expect(events).toEqual([PRESENCE_READY_EVENT]);
});

test("non-interactive sessions return the UI-unavailable error", async () => {
  const { tool } = register();
  const result = await tool.execute("call-1", SINGLE_QUESTION, undefined, undefined, {
    mode: "headless",
  } as unknown as ExtensionContext);

  expect(result.content[0]!.text).toBe(NON_INTERACTIVE_MESSAGE);
  const details = result.details as QuestionnaireResult;
  expect(details.cancelled).toBe(true);
  expect(details.cancelReason).toBe("unavailable");
});

test("invalid parameters are rejected before the UI opens", async () => {
  const { tool } = register();
  let opened = false;
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      async custom() {
        opened = true;
        throw new Error("must not open");
      },
    },
  } as unknown as ExtensionContext;

  const result = await tool.execute("call-1", { questions: [] }, undefined, undefined, ctx);
  expect(result.content[0]!.text).toBe("Error: No questions provided");
  expect(opened).toBe(false);
});

test("a completed questionnaire returns labeled text and structured details", async () => {
  const { tool } = register();
  const result = await tool.execute("call-1", SINGLE_QUESTION, undefined, undefined, tuiContext(["\u001b[B", "\r"]));

  expect(result.content[0]!.text).toBe("Language: English [en]");
  const details = result.details as QuestionnaireResult;
  expect(details.cancelled).toBe(false);
  expect(details.answers).toEqual([{ id: "lang", kind: "single", value: "en", label: "English", index: 2 }]);
});

test("digit keys select an option directly", async () => {
  const { tool } = register();
  const result = await tool.execute("call-1", SINGLE_QUESTION, undefined, undefined, tuiContext(["2"]));

  expect(result.content[0]!.text).toBe("Language: English [en]");
});

test("a cancelled questionnaire reports the reason and any partial answers", async () => {
  const { tool } = register();
  const result = await tool.execute("call-1", SINGLE_QUESTION, undefined, undefined, tuiContext(["\u001b"]));

  expect(result.content[0]!.text).toBe(`${CANCELLED_MESSAGE} (the user cancelled)`);
  const details = result.details as QuestionnaireResult;
  expect(details.cancelled).toBe(true);
  expect(details.cancelReason).toBe("user");
});

test("an already aborted signal cancels the questionnaire as aborted", async () => {
  const { tool } = register();
  const controller = new AbortController();
  controller.abort();

  const result = await tool.execute("call-1", SINGLE_QUESTION, controller.signal, undefined, tuiContext([]));
  expect(result.content[0]!.text).toContain("the tool call was aborted");
  expect((result.details as QuestionnaireResult).cancelReason).toBe("aborted");
});

test("an abort before the component mounts still cancels", async () => {
  const { tool } = register();
  const controller = new AbortController();
  controller.abort();

  const result = await tool.execute(
    "call-1",
    SINGLE_QUESTION,
    controller.signal,
    undefined,
    tuiContext([], "s1", true),
  );
  expect(result.content[0]!.text).toContain(CANCELLED_MESSAGE);
  expect((result.details as QuestionnaireResult).cancelReason).toBe("aborted");
});

test("an abort while the questionnaire is open cancels it", async () => {
  const { tool } = register();
  const controller = new AbortController();
  const pending = tool.execute("call-1", SINGLE_QUESTION, controller.signal, undefined, tuiContext([], "s1", true));

  controller.abort();
  const result = await pending;
  expect(result.content[0]!.text).toContain(CANCELLED_MESSAGE);
  expect((result.details as QuestionnaireResult).cancelReason).toBe("aborted");
});

test("abort listeners are removed after settled success and rejected UI paths", async () => {
  const { tool } = register();
  const success = trackedAbortSignal();
  await tool.execute("call-1", SINGLE_QUESTION, success.signal, undefined, tuiContext(["\u001b[B", "\r"]));
  expect(success.listenerCount()).toBe(0);

  const rejection = trackedAbortSignal();
  const rejectedContext = {
    mode: "tui",
    sessionManager: { getSessionId: () => "s1" },
    ui: { custom: () => Promise.reject(new Error("ui.custom rejected")) },
  } as unknown as ExtensionContext;
  await expect(tool.execute("call-1", SINGLE_QUESTION, rejection.signal, undefined, rejectedContext)).rejects.toThrow();
  expect(rejection.listenerCount()).toBe(0);
});

for (const [name, context] of [
  [
    "ui.custom throws synchronously",
    () =>
      ({
        mode: "tui",
        sessionManager: { getSessionId: () => "s1" },
        ui: {
          custom: () => {
            throw new Error("ui.custom failed");
          },
        },
      }) as unknown as ExtensionContext,
  ],
  ["the questionnaire factory throws", factoryThrowingContext],
  [
    "ui.custom rejects asynchronously",
    () =>
      ({
        mode: "tui",
        sessionManager: { getSessionId: () => "s1" },
        ui: { custom: () => Promise.reject(new Error("ui.custom rejected")) },
      }) as unknown as ExtensionContext,
  ],
] as const) {
  test(`presence is withdrawn when ${name}`, async () => {
    const registration = register();
    const ctx = context();
    activatePresence(registration, ctx);

    await expect(registration.tool.execute("call-1", SINGLE_QUESTION, undefined, undefined, ctx)).rejects.toThrow();
    expect(registration.emitted.map(({ event }) => event)).toEqual([
      PRESENCE_READY_EVENT,
      PRESENCE_UPDATE_EVENT,
      PRESENCE_REMOVE_EVENT,
    ]);
  });
}

for (const [name, script, abort] of [
  ["completes normally", ["\u001b[B", "\r"], false],
  ["is cancelled by the user", ["\u001b"], false],
  ["is aborted", [], true],
] as const) {
  test(`presence follows the full lifecycle when the questionnaire ${name}`, async () => {
    const registration = register();
    const ctx = tuiContext([...script]);
    const controller = abort ? new AbortController() : undefined;
    activatePresence(registration, ctx);

    const result = registration.tool.execute("call-1", SINGLE_QUESTION, controller?.signal, undefined, ctx);
    if (controller) controller.abort();
    await result;

    expect(registration.emitted.map(({ event }) => event)).toEqual([
      PRESENCE_READY_EVENT,
      PRESENCE_UPDATE_EVENT,
      PRESENCE_REMOVE_EVENT,
    ]);
    expect(presenceEvents(registration)[0]!.payload).toMatchObject({
      counts: { active: 1, total: 1 },
      attention: "info",
    });
  });
}

for (const profile of CANONICAL_CONSUMER_PROFILES) {
  test(`${profile.name} receives one strict private-safe removal after question resolution`, async () => {
    const registration = register();
    const ctx = tuiContext(["\r"]);
    registration.lifecycleListeners.get("session_start")?.({}, ctx);
    registration.eventListeners.get(PRESENCE_READY_EVENT)?.(readyAdvertisement(profile, "s1"));

    const result = await registration.tool.execute("call-1", PRIVACY_SENTINEL_QUESTION, undefined, undefined, ctx);
    expect((result.details as QuestionnaireResult).cancelled).toBe(false);

    const output = presenceEvents(registration);
    expect(output.map(({ event }) => event)).toEqual([PRESENCE_UPDATE_EVENT, PRESENCE_REMOVE_EVENT]);
    expect(isStrictWaitingUpdate(output[0]?.payload)).toBe(true);
    expect(isStrictRemoval(output[1]?.payload)).toBe(true);
    for (const { payload } of registration.emitted) {
      expect(isPrivacySafePresencePayload(payload, "s1")).toBe(true);
      expect((payload as { sessionId?: unknown }).sessionId).toBe("s1");
      const serializedPayload = JSON.stringify(payload);
      for (const sentinel of QUESTIONNAIRE_SENTINELS) expect(serializedPayload).not.toContain(sentinel);
    }
  });
}

test("session shutdown withdraws pending presence without a duplicate removal", async () => {
  const registration = register();
  const controller = new AbortController();
  const ctx = tuiContext([]);
  activatePresence(registration, ctx);

  const pending = registration.tool.execute("call-1", SINGLE_QUESTION, controller.signal, undefined, ctx);
  expect(registration.emitted.map(({ event }) => event)).toEqual([PRESENCE_READY_EVENT, PRESENCE_UPDATE_EVENT]);

  registration.lifecycleListeners.get("session_shutdown")?.({} as never, {} as ExtensionContext);
  expect(registration.emitted.map(({ event }) => event)).toEqual([
    PRESENCE_READY_EVENT,
    PRESENCE_UPDATE_EVENT,
    PRESENCE_REMOVE_EVENT,
  ]);

  controller.abort();
  await pending;
  expect(presenceEvents(registration).map(({ event }) => event)).toEqual([
    PRESENCE_UPDATE_EVENT,
    PRESENCE_REMOVE_EVENT,
  ]);
});

test("renderCall summarizes the question count and labels", () => {
  const { tool } = register();
  const single = tool.renderCall({ questions: [{ label: "Language" }] }, fakeTheme(), {}) as { text: string };
  expect(single.text).toContain(TOOL_NAME);
  expect(single.text).toContain("1 question");
  expect(single.text).toContain("(Language)");

  const plural = tool.renderCall({ questions: [{ label: "A" }, { label: "B" }] }, fakeTheme(), {}) as { text: string };
  expect(plural.text).toContain("2 questions");
  expect(plural.text).toContain("(A, B)");

  const empty = tool.renderCall({}, fakeTheme(), {}) as { text: string };
  expect(empty.text).toContain("0 questions");
  expect(empty.text).not.toContain("(");
});

test("renderResult marks answers, free text, skips, and cancellation", () => {
  const { tool } = register();
  const questions = [makeQuestion({ id: "lang", label: "Language" })];

  const answered = tool.renderResult(
    {
      content: [{ type: "text", text: "Language: Korean" }],
      details: {
        questions,
        answers: [{ id: "lang", kind: "custom", value: "Klingon", label: "Klingon" }],
        cancelled: false,
      } satisfies QuestionnaireResult,
    },
    {},
    fakeTheme(),
    {},
  ) as { text: string };
  expect(answered.text).toBe("✓ Language: (wrote) Klingon");

  const skipped = tool.renderResult(
    {
      content: [{ type: "text", text: "Language: (skipped)" }],
      details: {
        questions,
        answers: [{ id: "lang", kind: "skipped" }],
        cancelled: false,
      } satisfies QuestionnaireResult,
    },
    {},
    fakeTheme(),
    {},
  ) as { text: string };
  expect(skipped.text).toBe("– Language: (skipped)");

  const cancelled = tool.renderResult(
    {
      content: [{ type: "text", text: CANCELLED_MESSAGE }],
      details: { questions, answers: [], cancelled: true, cancelReason: "user" } satisfies QuestionnaireResult,
    },
    {},
    fakeTheme(),
    {},
  ) as { text: string };
  expect(cancelled.text).toBe("Cancelled");

  const aborted = tool.renderResult(
    {
      content: [{ type: "text", text: CANCELLED_MESSAGE }],
      details: { questions, answers: [], cancelled: true, cancelReason: "aborted" } satisfies QuestionnaireResult,
    },
    {},
    fakeTheme(),
    {},
  ) as { text: string };
  expect(aborted.text).toBe("Cancelled (aborted)");
});

test("renderResult falls back to the plain content text without details", () => {
  const { tool } = register();
  const result = tool.renderResult(
    { content: [{ type: "text", text: NON_INTERACTIVE_MESSAGE }] },
    {},
    fakeTheme(),
    {},
  ) as { text: string };
  expect(result.text).toBe(NON_INTERACTIVE_MESSAGE);
});
