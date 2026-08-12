import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import askUser from "../index.ts";
import { PRESENCE_READY_EVENT } from "../src/presence.ts";
import {
  CANCELLED_MESSAGE,
  NON_INTERACTIVE_MESSAGE,
  TOOL_DESCRIPTION,
  TOOL_LABEL,
  TOOL_NAME,
} from "../src/tool.ts";
import type { QuestionnaireResult } from "../src/types.ts";
import { fakeTheme, fakeTui } from "./helpers/fake-theme.ts";

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: any;
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

function register() {
  const hooks: string[] = [];
  const events: string[] = [];
  const tools: RegisteredTool[] = [];
  askUser({
    on(name: string) {
      hooks.push(name);
    },
    events: {
      on(name: string) {
        events.push(name);
      },
      emit() {},
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  return { hooks, events, tool: tools[0]!, tools };
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
      custom<T>(
        factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => any,
      ): Promise<T> {
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
  expect((result.details as QuestionnaireResult).cancelled).toBe(true);
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

  expect(result.content[0]!.text).toBe("Language: English");
  const details = result.details as QuestionnaireResult;
  expect(details.cancelled).toBe(false);
  expect(details.answers).toEqual([{ id: "lang", kind: "single", value: "en", label: "English", index: 2 }]);
});

test("a cancelled questionnaire reports the cancellation message", async () => {
  const { tool } = register();
  const result = await tool.execute("call-1", SINGLE_QUESTION, undefined, undefined, tuiContext(["\u001b"]));

  expect(result.content[0]!.text).toBe(CANCELLED_MESSAGE);
  expect((result.details as QuestionnaireResult).cancelled).toBe(true);
});

test("an already aborted signal cancels the questionnaire", async () => {
  const { tool } = register();
  const controller = new AbortController();
  controller.abort();

  const result = await tool.execute("call-1", SINGLE_QUESTION, controller.signal, undefined, tuiContext([]));
  expect(result.content[0]!.text).toBe(CANCELLED_MESSAGE);
});

test("an abort before the component mounts still cancels", async () => {
  const { tool } = register();
  const controller = new AbortController();
  controller.abort();

  const result = await tool.execute("call-1", SINGLE_QUESTION, controller.signal, undefined, tuiContext([], "s1", true));
  expect(result.content[0]!.text).toBe(CANCELLED_MESSAGE);
});

test("an abort while the questionnaire is open cancels it", async () => {
  const { tool } = register();
  const controller = new AbortController();
  const pending = tool.execute("call-1", SINGLE_QUESTION, controller.signal, undefined, tuiContext([], "s1", true));

  controller.abort();
  const result = await pending;
  expect(result.content[0]!.text).toBe(CANCELLED_MESSAGE);
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

test("renderResult marks answers, free text, and cancellation", () => {
  const { tool } = register();
  const questions = SINGLE_QUESTION.questions.map((item) => ({
    ...item,
    multiSelect: false,
    allowOther: true,
  })) as QuestionnaireResult["questions"];

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

  const cancelled = tool.renderResult(
    {
      content: [{ type: "text", text: CANCELLED_MESSAGE }],
      details: { questions, answers: [], cancelled: true } satisfies QuestionnaireResult,
    },
    {},
    fakeTheme(),
    {},
  ) as { text: string };
  expect(cancelled.text).toBe("Cancelled");
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
