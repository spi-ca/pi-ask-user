import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EVENT_NAMES } from "@pi/presence";
import { Check } from "typebox/value";
import askUser from "../index.ts";
import { QuestionnaireOutput, type StructuredQuestionnaireResult } from "../src/result.ts";
import { CANCELLED_MESSAGE, NON_INTERACTIVE_MESSAGE, TOOL_DESCRIPTION, TOOL_LABEL, TOOL_NAME } from "../src/tool.ts";
import type { QuestionnaireResult } from "../src/types.ts";
import { fakeTheme, fakeTui } from "./helpers/fake-theme.ts";
import {
  attachV2Consumer,
  createEventBus,
  QUESTIONNAIRE_SENTINELS,
  serializedPayloadsArePrivate,
} from "./helpers/presence-consumer.ts";
import { makeQuestion } from "./helpers/question.ts";

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  executionMode: string;
  exposure: string;
  outputSchema: typeof QuestionnaireOutput;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    content: { type: string; text: string }[];
    details?: unknown;
    structuredContent: StructuredQuestionnaireResult;
    isError?: boolean;
  }>;
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
const shutdowns: Array<() => void> = [];
afterEach(() => {
  for (const shutdown of shutdowns.splice(0)) shutdown();
});
type CustomComponent = { focused: boolean; handleInput(data: string): void };
type CustomFactory<T> = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (result: T) => void,
) => CustomComponent;

function questionsProxyWithLength(length: unknown): unknown[] {
  return new Proxy([], {
    get(target, property, receiver) {
      if (property === "length") return length;
      return Reflect.get(target, property, receiver);
    },
  });
}

function register() {
  const hooks: string[] = [];
  const events: string[] = [];
  const emitted: { event: string; payload: unknown }[] = [];
  const bus = createEventBus();
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
        bus.emit(event, payload);
      },
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  const registration = { hooks, events, emitted, eventListeners, lifecycleListeners, tool: tools[0]!, tools, bus };
  shutdowns.push(() => registration.lifecycleListeners.get("session_shutdown")?.({}, {} as ExtensionContext));
  return registration;
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

const SENTINEL_QUESTION = {
  questions: [
    {
      id: QUESTIONNAIRE_SENTINELS[0],
      label: QUESTIONNAIRE_SENTINELS[1],
      prompt: QUESTIONNAIRE_SENTINELS[2],
      allowOther: true,
      otherLabel: QUESTIONNAIRE_SENTINELS[6],
      otherPlaceholder: QUESTIONNAIRE_SENTINELS[7],
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

function attachToolPresence(registration: ReturnType<typeof register>, ctx: ExtensionContext) {
  registration.lifecycleListeners.get("session_start")?.({}, ctx);
  const consumer = attachV2Consumer(registration.bus);
  shutdowns.push(() => consumer.deactivate());
  return consumer;
}

function closeToolPresence(
  registration: ReturnType<typeof register>,
  consumer: ReturnType<typeof attachV2Consumer>,
): void {
  registration.lifecycleListeners.get("session_shutdown")?.({}, {} as ExtensionContext);
  consumer.deactivate();
}

function assertPrivateToolPresence(
  registration: ReturnType<typeof register>,
  consumer: ReturnType<typeof attachV2Consumer>,
): void {
  const output = registration.emitted.filter(
    ({ event }) => event === EVENT_NAMES.state || event === EVENT_NAMES.withdraw,
  );
  expect(output).toHaveLength(2);
  expect(consumer.received).toHaveLength(2);
  expect(serializedPayloadsArePrivate(output.map(({ payload }) => payload))).toBe(true);

  for (const { event, payload } of output) {
    const state = event === EVENT_NAMES.state;
    expect(Object.keys(payload as object).sort()).toEqual(
      state
        ? ["attention", "generation", "interaction", "sequence", "sessionEpoch", "source", "state", "version"]
        : ["generation", "sequence", "sessionEpoch", "source", "version"],
    );
    if (state) {
      expect(payload).toMatchObject({
        interaction: { kind: "ask_user", pending: 1 },
        attention: { reason: "input_required", occurrence: "new" },
      });
      expect(Object.keys((payload as { interaction: object }).interaction).sort()).toEqual(["kind", "pending"]);
      expect(Object.keys((payload as { attention: object }).attention).sort()).toEqual(["occurrence", "reason"]);
    }
    const serialized = JSON.stringify(payload);
    for (const sentinel of QUESTIONNAIRE_SENTINELS) expect(serialized).not.toContain(sentinel);
  }
}

function factoryThrowingContext(sessionId = QUESTIONNAIRE_SENTINELS[8]): ExtensionContext {
  return {
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      custom<T>(factory: CustomFactory<T>): Promise<T> {
        factory(
          fakeTui(),
          fakeTheme(),
          new Proxy(
            {},
            {
              get() {
                throw new Error("factory failed");
              },
            },
          ),
          () => undefined,
        );
        throw new Error("factory unexpectedly returned");
      },
    },
  } as unknown as ExtensionContext;
}

function cancelledResultContext(sessionId = QUESTIONNAIRE_SENTINELS[8]): ExtensionContext {
  return {
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      custom<T>(factory: CustomFactory<T>): Promise<T> {
        let settle: ((result: T) => void) | undefined;
        const result = new Promise<T>((resolve) => {
          settle = resolve;
        });
        const component = factory(fakeTui(), fakeTheme(), {}, (value) => settle?.(value));
        component.focused = true;
        queueMicrotask(() =>
          settle?.({
            questions: [],
            answers: [
              {
                id: QUESTIONNAIRE_SENTINELS[0],
                kind: "custom",
                value: QUESTIONNAIRE_SENTINELS[6],
                label: QUESTIONNAIRE_SENTINELS[6],
              },
            ],
            cancelled: true,
            cancelReason: QUESTIONNAIRE_SENTINELS[7],
          } as unknown as T),
        );
        return result;
      },
    },
  } as unknown as ExtensionContext;
}

function assertStructuredResult(tool: RegisteredTool, result: Awaited<ReturnType<RegisteredTool["execute"]>>): void {
  const details = result.details as QuestionnaireResult;
  expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
  expect(result.structuredContent).toEqual({
    answers: details.answers,
    cancelled: details.cancelled,
    ...(details.cancelReason === undefined ? {} : { cancelReason: details.cancelReason }),
  });
  expect(result.structuredContent).not.toHaveProperty("questions");
  // Returning an error-looking text never set isError before this migration.
  expect(result).not.toHaveProperty("isError");
  expect(result.structuredContent.answers).not.toBe(details.answers);
}

test("the entrypoint keeps the public tool registration contract", () => {
  const { hooks, events, tools, tool } = register();

  expect(tools).toHaveLength(1);
  expect(tool.name).toBe(TOOL_NAME);
  expect(tool.label).toBe(TOOL_LABEL);
  expect(tool.description).toBe(TOOL_DESCRIPTION);
  expect(tool.executionMode).toBe("sequential");
  expect(tool.exposure).toBe("model-only");
  expect(tool.outputSchema).toBe(QuestionnaireOutput);
  expect(hooks).toEqual(["session_start", "session_shutdown"]);
  expect(events).toEqual([]);
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
  assertStructuredResult(tool, result);
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
  assertStructuredResult(tool, result);
});

test("a completed questionnaire returns labeled text and structured details", async () => {
  const { tool } = register();
  const result = await tool.execute("call-1", SINGLE_QUESTION, undefined, undefined, tuiContext(["\u001b[B", "\r"]));

  expect(result.content[0]!.text).toBe('Language: English ["en"]');
  const details = result.details as QuestionnaireResult;
  expect(details.cancelled).toBe(false);
  expect(details.answers).toEqual([{ id: "lang", kind: "single", value: "en", label: "English", index: 2 }]);
  assertStructuredResult(tool, result);
});

test("digit keys select an option directly", async () => {
  const { tool } = register();
  const result = await tool.execute("call-1", SINGLE_QUESTION, undefined, undefined, tuiContext(["2"]));

  expect(result.content[0]!.text).toBe('Language: English ["en"]');
});

test("a cancelled questionnaire reports the reason and any partial answers", async () => {
  const { tool } = register();
  const result = await tool.execute("call-1", SINGLE_QUESTION, undefined, undefined, tuiContext(["\u001b"]));

  expect(result.content[0]!.text).toBe(`${CANCELLED_MESSAGE} (the user cancelled)`);
  const details = result.details as QuestionnaireResult;
  expect(details.cancelled).toBe(true);
  expect(details.cancelReason).toBe("user");
  assertStructuredResult(tool, result);
});

test("an already aborted signal cancels the questionnaire as aborted", async () => {
  const { tool } = register();
  const controller = new AbortController();
  controller.abort();

  const result = await tool.execute("call-1", SINGLE_QUESTION, controller.signal, undefined, tuiContext([]));
  expect(result.content[0]!.text).toContain("the tool call was aborted");
  expect((result.details as QuestionnaireResult).cancelReason).toBe("aborted");
  assertStructuredResult(tool, result);
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
  assertStructuredResult(tool, result);
});

test("an abort while the questionnaire is open cancels it", async () => {
  const { tool } = register();
  const controller = new AbortController();
  const pending = tool.execute("call-1", SINGLE_QUESTION, controller.signal, undefined, tuiContext([], "s1", true));

  controller.abort();
  const result = await pending;
  expect(result.content[0]!.text).toContain(CANCELLED_MESSAGE);
  expect((result.details as QuestionnaireResult).cancelReason).toBe("aborted");
  assertStructuredResult(tool, result);
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

test("V2 presence follows tool success, cancellation, abort, UI failures, and shutdown without exposing inputs", async () => {
  const success = register();
  const successContext = tuiContext(["\u001b[B", "\r", QUESTIONNAIRE_SENTINELS[6], "\r"], QUESTIONNAIRE_SENTINELS[8]);
  const successConsumer = attachToolPresence(success, successContext);
  const successResult = await success.tool.execute("call-1", SENTINEL_QUESTION, undefined, undefined, successContext);
  expect((successResult.details as QuestionnaireResult).answers).toMatchObject([
    { kind: "custom", value: QUESTIONNAIRE_SENTINELS[6] },
  ]);
  assertStructuredResult(success.tool, successResult);
  expect(JSON.stringify(successResult.structuredContent)).toContain(QUESTIONNAIRE_SENTINELS[6]);
  assertPrivateToolPresence(success, successConsumer);
  closeToolPresence(success, successConsumer);

  const cancelled = register();
  const cancelledContext = tuiContext(["\u001b"], QUESTIONNAIRE_SENTINELS[8]);
  const cancelledConsumer = attachToolPresence(cancelled, cancelledContext);
  const cancelledResult = await cancelled.tool.execute(
    "call-2",
    SENTINEL_QUESTION,
    undefined,
    undefined,
    cancelledContext,
  );
  expect((cancelledResult.details as QuestionnaireResult).cancelReason).toBe("user");
  assertPrivateToolPresence(cancelled, cancelledConsumer);
  closeToolPresence(cancelled, cancelledConsumer);

  const aborted = register();
  const abortedContext = tuiContext([], QUESTIONNAIRE_SENTINELS[8], true);
  const controller = new AbortController();
  const abortedConsumer = attachToolPresence(aborted, abortedContext);
  const abortedResult = aborted.tool.execute("call-3", SENTINEL_QUESTION, controller.signal, undefined, abortedContext);
  controller.abort();
  expect((await abortedResult).details as QuestionnaireResult).toMatchObject({ cancelReason: "aborted" });
  assertPrivateToolPresence(aborted, abortedConsumer);
  closeToolPresence(aborted, abortedConsumer);

  const syncUiFailure = register();
  const syncUiContext = {
    mode: "tui",
    sessionManager: { getSessionId: () => QUESTIONNAIRE_SENTINELS[8] },
    ui: {
      custom: () => {
        throw new Error("ui.custom sentinel failure");
      },
    },
  } as unknown as ExtensionContext;
  const syncUiConsumer = attachToolPresence(syncUiFailure, syncUiContext);
  await expect(
    syncUiFailure.tool.execute("call-4", SENTINEL_QUESTION, undefined, undefined, syncUiContext),
  ).rejects.toThrow("ui.custom sentinel failure");
  assertPrivateToolPresence(syncUiFailure, syncUiConsumer);
  closeToolPresence(syncUiFailure, syncUiConsumer);

  const factoryFailure = register();
  const factoryContext = factoryThrowingContext();
  const factoryConsumer = attachToolPresence(factoryFailure, factoryContext);
  await expect(
    factoryFailure.tool.execute("call-5", SENTINEL_QUESTION, undefined, undefined, factoryContext),
  ).rejects.toThrow("factory failed");
  assertPrivateToolPresence(factoryFailure, factoryConsumer);
  closeToolPresence(factoryFailure, factoryConsumer);

  const asyncUiFailure = register();
  const asyncUiContext = {
    mode: "tui",
    sessionManager: { getSessionId: () => QUESTIONNAIRE_SENTINELS[8] },
    ui: { custom: () => Promise.reject(new Error("ui.custom async sentinel failure")) },
  } as unknown as ExtensionContext;
  const asyncUiConsumer = attachToolPresence(asyncUiFailure, asyncUiContext);
  await expect(
    asyncUiFailure.tool.execute("call-6", SENTINEL_QUESTION, undefined, undefined, asyncUiContext),
  ).rejects.toThrow("ui.custom async sentinel failure");
  assertPrivateToolPresence(asyncUiFailure, asyncUiConsumer);
  closeToolPresence(asyncUiFailure, asyncUiConsumer);

  const shutdown = register();
  const shutdownContext = tuiContext([], QUESTIONNAIRE_SENTINELS[8], true);
  const shutdownController = new AbortController();
  const shutdownConsumer = attachToolPresence(shutdown, shutdownContext);
  const pending = shutdown.tool.execute(
    "call-7",
    SENTINEL_QUESTION,
    shutdownController.signal,
    undefined,
    shutdownContext,
  );
  shutdown.lifecycleListeners.get("session_shutdown")?.({}, shutdownContext);
  shutdownController.abort();
  await pending;
  assertPrivateToolPresence(shutdown, shutdownConsumer);
  closeToolPresence(shutdown, shutdownConsumer);
});

test("V2 presence excludes host-supplied cancellation and answer data", async () => {
  const registration = register();
  const ctx = cancelledResultContext();
  const consumer = attachToolPresence(registration, ctx);

  const result = await registration.tool.execute("call-8", SENTINEL_QUESTION, undefined, undefined, ctx);
  expect((result.details as QuestionnaireResult).cancelReason as unknown).toBe(QUESTIONNAIRE_SENTINELS[7]);
  assertPrivateToolPresence(registration, consumer);
  closeToolPresence(registration, consumer);
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

test("renderCall fails closed for throwing getters and revoked proxies", () => {
  const { tool } = register();
  const throwingQuestions = Object.defineProperty({}, "questions", {
    get() {
      throw new Error("malformed arguments");
    },
  });
  const arrayProxy = Proxy.revocable([], {});
  const questionProxy = Proxy.revocable({}, {});
  arrayProxy.revoke();
  questionProxy.revoke();

  const getterResult = tool.renderCall(throwingQuestions, fakeTheme(), {}) as { text: string };
  const proxyResult = tool.renderCall({ questions: arrayProxy.proxy }, fakeTheme(), {}) as { text: string };
  const questionProxyResult = tool.renderCall({ questions: [questionProxy.proxy] }, fakeTheme(), {}) as {
    text: string;
  };

  expect(getterResult.text).toContain("0 questions");
  expect(getterResult.text).not.toContain("(");
  expect(proxyResult.text).toContain("0 questions");
  expect(proxyResult.text).not.toContain("(");
  expect(questionProxyResult.text).toContain("0 questions");
  expect(questionProxyResult.text).not.toContain("(");
});

test("renderCall fails closed for questions proxies with malformed lengths", () => {
  const { tool } = register();
  const throwingLength = {
    valueOf() {
      throw new Error("length coercion must not run");
    },
  };

  for (const length of [Symbol("length"), throwingLength]) {
    const result = tool.renderCall({ questions: questionsProxyWithLength(length) }, fakeTheme(), {}) as {
      text: string;
    };
    expect(result.text).toContain("0 questions");
    expect(result.text).not.toContain("(");
  }
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

test("structured output covers multi, custom-only multi, custom, and skipped UI answers", async () => {
  const { tool } = register();
  const base = SINGLE_QUESTION.questions[0]!;
  const cases = [
    { question: { ...base, multiSelect: true }, keys: ["1", "2", "3", "extra", "\r"], kind: "multi" },
    { question: { ...base, multiSelect: true }, keys: ["3", "extra", "\r"], kind: "multi" },
    { question: base, keys: ["3", "extra", "\r"], kind: "custom" },
    { question: { ...base, optional: true }, keys: ["4"], kind: "skipped" },
  ];
  for (const { question, keys, kind } of cases) {
    const result = await tool.execute("variants", { questions: [question] }, undefined, undefined, tuiContext(keys));
    assertStructuredResult(tool, result);
    expect(result.structuredContent.answers[0]?.kind as string).toBe(kind);
  }
});

test("structured cancellation keeps partial answers and the model-visible text", async () => {
  const { tool } = register();
  const questions = [SINGLE_QUESTION.questions[0]!, { ...SINGLE_QUESTION.questions[0]!, id: "next" }];
  const result = await tool.execute("partial", { questions }, undefined, undefined, tuiContext(["2", "\u001b"]));
  assertStructuredResult(tool, result);
  expect(result.structuredContent).toMatchObject({
    cancelled: true,
    cancelReason: "user",
    answers: [{ id: "lang", kind: "single", value: "en", index: 2 }],
  });
  expect(result.content[0]!.text).toBe(
    `${CANCELLED_MESSAGE} (the user cancelled)\nAnswered so far:\nLanguage: English ["en"]`,
  );
});

test("structured output and details detach nested answers in both mutation directions", async () => {
  const { tool } = register();
  const result = await tool.execute(
    "sharing",
    {
      questions: [{ ...SINGLE_QUESTION.questions[0]!, multiSelect: true }],
    },
    undefined,
    undefined,
    tuiContext(["1", "2", "3", "extra", "\r"]),
  );
  assertStructuredResult(tool, result);
  const details = result.details as QuestionnaireResult;
  const machine = result.structuredContent.answers[0]!;
  const ui = details.answers[0]!;
  if (machine.kind !== "multi" || ui.kind !== "multi") throw new Error("expected multi answer");
  expect(machine).not.toBe(ui);
  expect(machine.selections).not.toBe(ui.selections);
  expect(machine.selections[0]).not.toBe(ui.selections[0]);
  machine.selections[0]!.value = "changed-machine";
  machine.custom = "changed-machine";
  expect(ui.selections[0]!.value).toBe("ko");
  expect(ui.custom).toBe("extra");
  ui.selections[1]!.label = "changed-ui";
  ui.custom = "changed-ui";
  expect(machine.selections[1]!.label).toBe("English");
  expect(machine.custom).toBe("changed-machine");
  expect(result.content[0]!.text).toBe('Language: Korean, English, extra ["ko","en","extra"]');
});

test("oversized result rejection also satisfies the output schema without changing isError", async () => {
  const { tool } = register();
  const questions = Array.from({ length: 20 }, (_, index) => ({
    ...SINGLE_QUESTION.questions[0]!,
    id: `q${index}`,
    otherMaxLength: 2000,
  }));
  const result = await tool.execute("oversize", { questions }, undefined, undefined, tuiContext([]));
  assertStructuredResult(tool, result);
  expect(result.structuredContent).toEqual({ answers: [], cancelled: true, cancelReason: "invalid" });
  expect((result.details as QuestionnaireResult).questions).toHaveLength(20);
  expect(result.content[0]!.text).toContain("could exceed Pi's 50KB");
});

test("aborted structured output also preserves already recorded partial answers", async () => {
  const { tool } = register();
  const controller = new AbortController();
  const questions = [SINGLE_QUESTION.questions[0]!, { ...SINGLE_QUESTION.questions[0]!, id: "next" }];
  const pending = tool.execute("partial-abort", { questions }, controller.signal, undefined, tuiContext(["2"]));
  queueMicrotask(() => controller.abort());
  const result = await pending;
  assertStructuredResult(tool, result);
  expect(result.structuredContent).toMatchObject({
    cancelled: true,
    cancelReason: "aborted",
    answers: [{ value: "en" }],
  });
  expect(result.content[0]!.text).toContain("the tool call was aborted");
  expect(result.content[0]!.text).toContain('Language: English ["en"]');
});
