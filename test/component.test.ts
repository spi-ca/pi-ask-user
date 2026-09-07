import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createQuestionnaireComponent, type QuestionnaireComponent } from "../src/component.ts";
import type { Question, QuestionnaireResult } from "../src/types.ts";
import { fakeTheme, fakeTui } from "./helpers/fake-theme.ts";
import { makeOptions, makeQuestion } from "./helpers/question.ts";

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const ENTER = "\r";
const ESCAPE = "\u001b";
const TAB = "\t";
const SPACE = " ";

function question(overrides: Partial<Question> = {}): Question {
  return makeQuestion({
    prompt: "Pick a language",
    options: [
      { value: "ko", label: "Korean", description: "기본값" },
      { value: "en", label: "English" },
    ],
    ...overrides,
  });
}

function mount(questions: Question[], options: { rows?: number; keybindings?: unknown; theme?: unknown } = {}) {
  const tui = fakeTui(80, options.rows ?? 40);
  const settled: QuestionnaireResult[] = [];
  const component = createQuestionnaireComponent({
    questions,
    tui: tui as never,
    theme: options.theme ?? fakeTheme(),
    keybindings: options.keybindings,
    done: (result) => settled.push(result),
  });
  component.focused = true;
  return { component, settled, tui, lines: (width = 60) => component.render(width) };
}

function type(component: { handleInput(data: string): void }, text: string): void {
  for (const character of text) component.handleInput(character);
}

test("renders the prompt, numbered options, descriptions, and the custom entry", () => {
  const { lines } = mount([question()]);
  const output = lines().join("\n");

  expect(output).toContain("Pick a language");
  expect(output).toContain("1. Korean");
  expect(output).toContain("기본값");
  expect(output).toContain("2. English");
  expect(output).toContain("3. Type something.");
  expect(output).toContain("↑↓ navigate • 1-9 jump • Enter select • Esc cancel");
});

test("a single question hides the tab bar and multiple questions show it", () => {
  expect(mount([question()]).lines().join("\n")).not.toContain("Submit");

  const multi = mount([question({ id: "a", label: "A" }), question({ id: "b", label: "B" })]);
  const output = multi.lines().join("\n");
  expect(output).toContain("□ A");
  expect(output).toContain("□ B");
  expect(output).toContain("✓ Submit");
  expect(output).toContain("Tab/←→ navigate");
});

test("rendered lines never exceed the requested width", () => {
  const { lines } = mount([question({ prompt: "A".repeat(200) })]);
  for (const line of lines(24)) expect(line.length).toBeLessThanOrEqual(24);
});

test("arrow keys move the cursor and Enter selects the highlighted option", () => {
  const { component, settled } = mount([question()]);

  component.handleInput(DOWN);
  component.handleInput(ENTER);

  expect(settled[0]!.cancelled).toBe(false);
  expect(settled[0]!.answers).toEqual([{ id: "lang", kind: "single", value: "en", label: "English", index: 2 }]);
});

test("boundary cursor keys are consumed without rerendering or dropping cached lines", () => {
  const { component, settled, tui } = mount([question({ allowOther: false })]);
  const first = component.render(60);
  const initialRenders = tui.renderCount();

  component.handleInput(UP);
  expect(tui.renderCount()).toBe(initialRenders);
  expect(component.render(60)).toBe(first);

  component.handleInput(DOWN);
  expect(tui.renderCount()).toBe(initialRenders + 1);
  const last = component.render(60);

  component.handleInput(DOWN);
  expect(tui.renderCount()).toBe(initialRenders + 1);
  expect(component.render(60)).toBe(last);

  component.handleInput(UP);
  component.handleInput(ENTER);
  expect(settled[0]!.answers[0]).toMatchObject({ value: "ko", index: 1 });
});

test("Escape cancels and reports the questionnaire as cancelled", () => {
  const { component, settled } = mount([question()]);
  component.handleInput(ESCAPE);

  expect(settled).toHaveLength(1);
  expect(settled[0]!.cancelled).toBe(true);
  expect(settled[0]!.answers).toEqual([]);
});

test("cancel() settles the questionnaire once, matching an aborted tool call", () => {
  const { component, settled } = mount([question()]);
  component.cancel();
  component.cancel();
  component.handleInput(ESCAPE);

  expect(settled).toHaveLength(1);
  expect(settled[0]!.cancelled).toBe(true);
  expect(settled[0]!.cancelReason).toBe("aborted");
});

test("the custom entry opens an editor and free-text input becomes the answer", () => {
  const { component, settled, lines } = mount([question()]);

  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(ENTER);

  const editing = lines().join("\n");
  expect(editing).toContain("Your answer:");
  expect(editing).toContain("Type something. ✎");
  expect(editing).toContain("Enter to submit • Esc to cancel");

  type(component, "Klingon");
  component.handleInput(ENTER);

  expect(settled[0]!.answers).toEqual([{ id: "lang", kind: "custom", value: "Klingon", label: "Klingon" }]);
});

test("blank free-text input shows an inline error and stays in the editor", () => {
  const { component, settled, lines } = mount([question()]);

  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(ENTER);
  component.handleInput(ENTER);

  expect(settled).toHaveLength(0);
  expect(lines().join("\n")).toContain("Enter a response before continuing");
});

test("Escape leaves the editor without cancelling the questionnaire", () => {
  const { component, settled, lines } = mount([question()]);

  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(ENTER);
  component.handleInput(ESCAPE);

  expect(settled).toHaveLength(0);
  expect(lines().join("\n")).not.toContain("Your answer:");
});

test("multi-select toggles with Space and confirms with Enter", () => {
  const { component, settled, lines } = mount([question({ multiSelect: true })]);

  expect(lines().join("\n")).toContain("☐ 1. Korean");

  component.handleInput(SPACE);
  expect(lines().join("\n")).toContain("☑ 1. Korean");

  component.handleInput(DOWN);
  component.handleInput(SPACE);
  component.handleInput(ENTER);

  expect(settled[0]!.answers).toEqual([
    {
      id: "lang",
      kind: "multi",
      selections: [
        { value: "ko", label: "Korean", index: 1 },
        { value: "en", label: "English", index: 2 },
      ],
    },
  ]);
});

test("confirming an empty multi-select shows an inline error", () => {
  const { component, settled, lines } = mount([question({ multiSelect: true })]);

  component.handleInput(ENTER);

  expect(settled).toHaveLength(0);
  expect(lines().join("\n")).toContain("Select at least one option before continuing");
});

test("Space on the custom entry does not toggle a selection", () => {
  const { component, lines } = mount([question({ multiSelect: true })]);

  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(SPACE);

  const output = lines().join("\n");
  expect(output).not.toContain("Your answer:");
  expect(output).toContain("☐ 1. Korean");
});

test("answering every question lands on the review tab and Enter submits", () => {
  const questions = [question({ id: "a", label: "A" }), question({ id: "b", label: "B" })];
  const { component, settled, lines } = mount(questions);

  component.handleInput(ENTER);
  component.handleInput(DOWN);
  component.handleInput(ENTER);

  const review = lines().join("\n");
  expect(review).toContain("Ready to submit");
  expect(review).toContain("A: Korean");
  expect(review).toContain("B: English");
  expect(review).toContain("Press Enter to submit");
  expect(settled).toHaveLength(0);

  component.handleInput(ENTER);
  expect(settled[0]!.cancelled).toBe(false);
  expect(settled[0]!.answers.map((answer) => answer.id)).toEqual(["a", "b"]);
});

test("the review tab lists unanswered questions and refuses to submit", () => {
  const questions = [question({ id: "a", label: "A" }), question({ id: "b", label: "B" })];
  const { component, settled, lines } = mount(questions);

  component.handleInput(TAB);
  component.handleInput(TAB);
  const review = lines().join("\n");
  expect(review).toContain("Unanswered: A, B");
  expect(review).toContain("jumps to the first unanswered question");

  expect(settled).toHaveLength(0);
});

test("Escape on the review tab cancels", () => {
  const { component, settled } = mount([question({ id: "a" }), question({ id: "b" })]);

  component.handleInput(TAB);
  component.handleInput(TAB);
  component.handleInput(ESCAPE);

  expect(settled[0]!.cancelled).toBe(true);
  expect(settled[0]!.cancelReason).toBe("user");
});

test("digit keys jump to a visible row and act on it", () => {
  const { component, settled } = mount([question()]);

  component.handleInput("2");

  expect(settled[0]!.answers[0]).toMatchObject({ value: "en", index: 2 });
});

test("a digit past the end of the list is ignored", () => {
  const { component, settled } = mount([question()]);

  component.handleInput("9");

  expect(settled).toHaveLength(0);
});

test("a digit toggles rather than confirms on a multi-select question", () => {
  const { component, settled, lines } = mount([question({ multiSelect: true })]);

  component.handleInput("2");

  expect(settled).toHaveLength(0);
  expect(lines().join("\n")).toContain("☑ 2. English");
});

test("a digit on the custom row opens the editor", () => {
  const { component, lines } = mount([question()]);

  component.handleInput("3");

  expect(lines().join("\n")).toContain("Your answer:");
});

test("long option lists show a window with overflow indicators", () => {
  const { component, lines } = mount([question({ options: makeOptions(30), allowOther: false })], { rows: 20 });

  const initial = lines().join("\n");
  expect(initial).toContain("1. OPT 1");
  expect(initial).toContain("more");
  expect(initial).not.toContain("30. OPT 30");

  for (let index = 0; index < 29; index++) component.handleInput(DOWN);
  const scrolled = lines().join("\n");
  expect(scrolled).toContain("30. OPT 30");
  expect(scrolled).toContain("↑");
  expect(scrolled).not.toContain("1. OPT 1\n");
});

test("option numbers are stable so a digit always reaches the same option", () => {
  const { component, settled, lines } = mount([question({ options: makeOptions(30), allowOther: false })], {
    rows: 20,
  });

  for (let index = 0; index < 29; index++) component.handleInput(DOWN);
  expect(lines().join("\n")).toContain("30. OPT 30");

  // Numbers label options, not window rows, so "1" scrolls back to option 1.
  component.handleInput("1");
  expect(settled[0]!.answers[0]).toMatchObject({ value: "opt1", index: 1 });
});

test("slash starts a filter that narrows the option list", () => {
  const { component, lines } = mount([
    question({
      options: [
        { value: "ko", label: "Korean" },
        { value: "en", label: "English" },
        { value: "ja", label: "Japanese" },
      ],
      allowOther: false,
    }),
  ]);

  component.handleInput("/");
  type(component, "jap");

  const output = lines().join("\n");
  expect(output).toContain("Filter: jap");
  expect(output).toContain("Japanese");
  expect(output).not.toContain("Korean");
  expect(output).toContain("Type to filter");
});

test("a filtered selection answers with the original option position", () => {
  const { component, settled } = mount([
    question({
      options: [
        { value: "ko", label: "Korean" },
        { value: "en", label: "English" },
        { value: "ja", label: "Japanese" },
      ],
      allowOther: false,
    }),
  ]);

  component.handleInput("/");
  type(component, "jap");
  component.handleInput(ENTER);

  expect(settled[0]!.answers[0]).toEqual({
    id: "lang",
    kind: "single",
    value: "ja",
    label: "Japanese",
    index: 3,
  });
});

test("Escape clears the filter instead of cancelling the questionnaire", () => {
  const { component, settled, lines } = mount([question({ allowOther: false })]);

  component.handleInput("/");
  type(component, "zzz");
  expect(lines().join("\n")).toContain("No options match the filter");

  component.handleInput(ESCAPE);
  expect(settled).toHaveLength(0);
  const restored = lines().join("\n");
  expect(restored).toContain("1. Korean");
  expect(restored).not.toContain("Filter:");

  component.handleInput(ESCAPE);
  expect(settled[0]!.cancelled).toBe(true);
});

test("Space still toggles while a filter is being typed", () => {
  const { component, lines } = mount([question({ multiSelect: true })]);

  component.handleInput("/");
  type(component, "kor");
  component.handleInput(SPACE);

  expect(lines().join("\n")).toContain("☑ 1. Korean");
});

test("a and c select and clear every multi-select option", () => {
  const { component, lines } = mount([question({ multiSelect: true })]);

  component.handleInput("a");
  let output = lines().join("\n");
  expect(output).toContain("☑ 1. Korean");
  expect(output).toContain("☑ 2. English");
  expect(output).toContain("2 selected");

  component.handleInput("c");
  output = lines().join("\n");
  expect(output).toContain("☐ 1. Korean");
  expect(output).toContain("0 selected");
});

test("a bounded multi-select question shows the range and refuses extra choices", () => {
  const { component, lines } = mount([
    question({ multiSelect: true, minSelections: 1, maxSelections: 1, options: makeOptions(3), allowOther: false }),
  ]);

  expect(lines().join("\n")).toContain("Choose exactly 1");

  component.handleInput(SPACE);
  component.handleInput(DOWN);
  component.handleInput(SPACE);

  const output = lines().join("\n");
  expect(output).toContain("Select at most 1 option");
  expect(output).toContain("1 selected");
});

test("multi-select free text is added alongside the chosen options", () => {
  const { component, settled, lines } = mount([question({ multiSelect: true })]);

  component.handleInput(SPACE);
  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(ENTER);
  type(component, "Klingon");
  component.handleInput(ENTER);

  expect(settled[0]!.answers).toEqual([
    {
      id: "lang",
      kind: "multi",
      selections: [{ value: "ko", label: "Korean", index: 1 }],
      custom: "Klingon",
    },
  ]);
  expect(lines).toBeDefined();
});

test("reopening the editor keeps the multi-select text that was already typed", () => {
  const { component, lines } = mount([
    question({ multiSelect: true, minSelections: 2, maxSelections: 2, allowOther: true }),
  ]);

  // Text alone does not meet minSelections, so the question stays open.
  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(ENTER);
  type(component, "Klingon");
  component.handleInput(ENTER);
  expect(lines().join("\n")).toContain("(wrote) Klingon");

  component.handleInput(ENTER);
  expect(lines().join("\n")).toContain("Klingon");
});

test("an optional question offers a skip row that records a skipped answer", () => {
  const { component, settled, lines } = mount([question({ optional: true, allowOther: false })]);

  expect(lines().join("\n")).toContain("3. Skip this question.");

  component.handleInput("3");
  expect(settled[0]!.answers).toEqual([{ id: "lang", kind: "skipped" }]);
});

test("requireReview keeps a single question open until the review tab submits", () => {
  const { component, settled, lines } = mount([question({ requireReview: true })]);

  component.handleInput(ENTER);
  expect(settled).toHaveLength(0);
  const review = lines().join("\n");
  expect(review).toContain("Ready to submit");
  expect(review).toContain("Language: Korean");

  component.handleInput(ENTER);
  expect(settled[0]!.cancelled).toBe(false);
});

test("defaultValues place the cursor and preselect multi-select options", () => {
  const single = mount([question({ options: makeOptions(3), defaultValues: ["opt3"], allowOther: false })]);
  single.component.handleInput(ENTER);
  expect(single.settled[0]!.answers[0]).toMatchObject({ value: "opt3" });

  const multi = mount([
    question({ multiSelect: true, options: makeOptions(3), defaultValues: ["opt2"], allowOther: false }),
  ]);
  expect(multi.lines().join("\n")).toContain("☑ 2. OPT 2");
});

test("Enter on an incomplete review jumps to the first unanswered question", () => {
  const questions = [question({ id: "a", label: "A" }), question({ id: "b", label: "B" })];
  const { component, settled, lines } = mount(questions);

  component.handleInput(TAB);
  component.handleInput(TAB);
  expect(lines().join("\n")).toContain("Unanswered: A, B");

  component.handleInput(ENTER);
  expect(settled).toHaveLength(0);
  expect(lines().join("\n")).not.toContain("Ready to submit");
});

test("returning to an answered question restores the cursor to that answer", () => {
  const questions = [
    question({ id: "a", label: "A", options: makeOptions(3), allowOther: false }),
    question({ id: "b", label: "B", allowOther: false }),
  ];
  const { component, lines } = mount(questions);

  component.handleInput("3");
  component.handleInput(LEFT);

  expect(lines().join("\n")).toContain("> 3. OPT 3");
});

test("custom keybindings replace the defaults in input and help text", () => {
  const keybindings = {
    matches: (data: string, keybinding: string) => (keybinding === "tui.select.confirm" ? data === "\u0013" : false),
    getKeys: (keybinding: string) => (keybinding === "tui.select.confirm" ? ["ctrl+s"] : ["escape"]),
  };
  const { component, settled, lines } = mount([question()], { keybindings });

  expect(lines().join("\n")).toContain("Ctrl+S select");

  // Enter was rebound away from confirm, so it must not select.
  component.handleInput(ENTER);
  expect(settled).toHaveLength(0);

  component.handleInput("\u0013");
  expect(settled[0]!.answers[0]).toMatchObject({ value: "ko" });
});

test("a keybindings manager that throws falls back to the default keys", () => {
  const keybindings = {
    matches: () => {
      throw new Error("broken");
    },
    getKeys: () => {
      throw new Error("broken");
    },
  };
  const { component, settled, lines } = mount([question()], { keybindings });

  expect(lines().join("\n")).toContain("Enter select");
  component.handleInput(ENTER);
  expect(settled[0]!.answers[0]).toMatchObject({ value: "ko" });
});

test("Escape still cancels when a manager claims every key", () => {
  // A manager matching everything would otherwise consume Enter and Escape as
  // cursor movement, leaving the questionnaire with no way out.
  const keybindings = { matches: () => true, getKeys: () => ["up"] };
  const { component, settled } = mount([question()], { keybindings });

  component.handleInput(ESCAPE);

  expect(settled).toHaveLength(1);
  expect(settled[0]!.cancelled).toBe(true);
  expect(settled[0]!.cancelReason).toBe("user");
});

test("the configured cancel key closes the free-text editor", () => {
  const CANCEL = "\u0018";
  const keybindings = {
    matches: (data: string, keybinding: string) => keybinding === "tui.select.cancel" && data === CANCEL,
    getKeys: (keybinding: string) => (keybinding === "tui.select.cancel" ? ["ctrl+x"] : ["enter"]),
  };
  const { component, settled, lines } = mount([question()], { keybindings });

  component.handleInput("3");
  expect(lines().join("\n")).toContain("Your answer:");
  expect(lines().join("\n")).toContain("Ctrl+X to cancel");

  component.handleInput(CANCEL);
  expect(lines().join("\n")).not.toContain("Your answer:");
  expect(settled).toHaveLength(0);
});

test("the editor hint names the input submit key, not the select confirm key", () => {
  const keybindings = {
    matches: () => false,
    getKeys: (keybinding: string) =>
      keybinding === "tui.input.submit" ? ["ctrl+m"] : keybinding === "tui.select.confirm" ? ["ctrl+s"] : ["escape"],
  };
  const { component, lines } = mount([question()], { keybindings });

  component.handleInput("3");
  const editing = lines().join("\n");
  expect(editing).toContain("Ctrl+M to submit");
  expect(editing).not.toContain("Ctrl+S to submit");
});

test("typing safe text leaves the cursor alone so mid-string edits work", () => {
  const { component, settled } = mount([question()]);

  component.handleInput("3");
  type(component, "abc");
  component.handleInput(LEFT);
  component.handleInput(LEFT);
  type(component, "X");
  component.handleInput(ENTER);

  // A cursor reset would have produced "abcX" instead.
  expect(settled[0]!.answers[0]).toMatchObject({ value: "aXbc" });
});

test("a space typed mid-word is preserved rather than trimmed away", () => {
  const { component, settled } = mount([question()]);

  component.handleInput("3");
  type(component, "two words");
  component.handleInput(ENTER);

  expect(settled[0]!.answers[0]).toMatchObject({ value: "two words" });
});

test("a blank submit keeps the inline error until the text changes", () => {
  const { component, lines } = mount([question()]);

  component.handleInput("3");
  component.handleInput(ENTER);
  expect(lines().join("\n")).toContain("Enter a response before continuing");

  // A second failed submit does not change the text, so the error stays.
  component.handleInput(ENTER);
  expect(lines().join("\n")).toContain("Enter a response before continuing");

  type(component, "x");
  expect(lines().join("\n")).not.toContain("Enter a response before continuing");
});

test("pasted control and bidi characters never reach the editor display", () => {
  const { component, settled, lines } = mount([question()]);

  component.handleInput("3");
  // pi-tui's own paste filter only drops code units below U+0020.
  type(component, "ko\u009brean\u202e");

  const editing = lines().join("\n");
  expect(editing).not.toContain("\u009b");
  expect(editing).not.toContain("\u202e");

  component.handleInput(ENTER);
  expect(settled[0]!.answers[0]).toMatchObject({ value: "korean" });
});

test("free text is capped at otherMaxLength while typing", () => {
  const { component, settled } = mount([question({ otherMaxLength: 5 })]);

  component.handleInput("3");
  type(component, "abcdefghij");
  component.handleInput(ENTER);

  expect([...(settled[0]!.answers[0] as { value: string }).value].length).toBe(5);
});

test("rendered lines stay within the width for filters, viewports, and bounds", () => {
  const { component, lines } = mount(
    [
      question({
        id: "a",
        label: "A".repeat(50),
        prompt: "P".repeat(200),
        multiSelect: true,
        minSelections: 2,
        maxSelections: 3,
        options: makeOptions(30, "verylongoptionname"),
      }),
      question({ id: "b" }),
    ],
    { rows: 18 },
  );

  component.handleInput("/");
  type(component, "very");
  component.handleInput(SPACE);
  component.handleInput(ENTER);

  for (const width of [1, 3, 10, 24, 80]) {
    // The cursor marker is a zero-width escape the TUI strips, so measure
    // visible width rather than raw string length.
    for (const line of lines(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test("Tab and arrow navigation wrap across question and review tabs", () => {
  const questions = [question({ id: "a", label: "A" }), question({ id: "b", label: "B" })];
  const { component, lines } = mount(questions);

  component.handleInput(RIGHT);
  expect(lines().join("\n")).toContain("Pick a language");

  component.handleInput(RIGHT);
  expect(lines().join("\n")).toContain("Ready to submit");

  component.handleInput(RIGHT);
  expect(lines().join("\n")).not.toContain("Ready to submit");

  component.handleInput(LEFT);
  expect(lines().join("\n")).toContain("Ready to submit");
});

test("answered tabs are marked in the tab bar", () => {
  const questions = [question({ id: "a", label: "A" }), question({ id: "b", label: "B" })];
  const { component, lines } = mount(questions);

  component.handleInput(ENTER);
  const output = lines().join("\n");
  expect(output).toContain("■ A");
  expect(output).toContain("□ B");
});

test("free-text answers are marked with (wrote) on the review tab", () => {
  const questions = [question({ id: "a", label: "A" }), question({ id: "b", label: "B" })];
  const { component, lines } = mount(questions);

  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(ENTER);
  type(component, "Klingon");
  component.handleInput(ENTER);
  component.handleInput(ENTER);

  expect(lines().join("\n")).toContain("A: (wrote) Klingon");
});

test("render output is cached per width and invalidated on state change", () => {
  const { component, tui } = mount([question()]);

  const first = component.render(60);
  expect(component.render(60)).toBe(first);
  expect(component.render(40)).not.toBe(first);

  const renders = tui.renderCount();
  component.handleInput(DOWN);
  expect(tui.renderCount()).toBeGreaterThan(renders);
  expect(component.render(60)).not.toBe(first);
});

test("invalidate() drops the cached lines", () => {
  const { component } = mount([question()]);
  const first = component.render(60);
  component.invalidate();
  expect(component.render(60)).not.toBe(first);
});

test("focus is tracked and mirrored to the editor", () => {
  const { component } = mount([question()]);
  expect(component.focused).toBe(true);
  component.focused = false;
  expect(component.focused).toBe(false);
});

function mouse(
  component: { handleMouse(event: Parameters<QuestionnaireComponent["handleMouse"]>[0]): unknown },
  type: "press" | "release" | "drag" | "click" | "wheel",
  x: number,
  y: number,
  options: { button?: "left" | "middle" | "right" | "none"; width?: number; wheelDelta?: number } = {},
) {
  return component.handleMouse({
    type,
    button: options.button ?? (type === "wheel" ? "none" : "left"),
    x,
    y,
    screenX: x,
    screenY: y,
    width: options.width ?? 60,
    height: 40,
    shift: false,
    alt: false,
    ctrl: false,
    ...(options.wheelDelta === undefined ? {} : { wheelDelta: options.wheelDelta }),
  });
}

function lineIndex(lines: string[], text: string): number {
  const index = lines.findIndex((line) => line.includes(text));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function cellX(line: string, text: string): number {
  const index = line.indexOf(text);
  expect(index).toBeGreaterThanOrEqual(0);
  return visibleWidth(line.slice(0, index));
}

test("mouse press moves an option cursor and click selects its semantic row", () => {
  const { component, settled, lines } = mount([question()]);
  const koreanY = lineIndex(lines(), "1. Korean");
  const englishY = lineIndex(lines(), "2. English");

  expect(mouse(component, "press", 3, koreanY)).toEqual({ handled: true, focus: true, render: false });
  expect(mouse(component, "press", 3, englishY)).toMatchObject({ handled: true, focus: true });
  expect(settled).toHaveLength(0);
  expect(lines().join("\n")).toContain("> 2. English");

  mouse(component, "click", 3, englishY);
  expect(settled[0]!.answers[0]).toMatchObject({ value: "en" });
});

test("mouse description hits wrapped option regions and multi click only toggles", () => {
  const wrapped = mount([
    question({
      options: [
        { value: "ko", label: "Korean", description: "a wrapped description that spans several terminal lines" },
      ],
      allowOther: false,
    }),
  ]);
  const descriptionY = lineIndex(wrapped.lines(24), "description");
  mouse(wrapped.component, "click", 5, descriptionY, { width: 24 });
  expect(wrapped.settled[0]!.answers[0]).toMatchObject({ value: "ko" });

  const narrow = mount([
    question({
      options: [{ value: "ko", label: "Korean", description: "description" }],
      allowOther: false,
    }),
  ]);
  const narrowLines = narrow.lines(3);
  const narrowDescriptionY = lineIndex(narrowLines, "des");
  mouse(narrow.component, "click", cellX(narrowLines[narrowDescriptionY]!, "des"), narrowDescriptionY, { width: 3 });
  expect(narrow.settled[0]!.answers[0]).toMatchObject({ value: "ko" });

  const multi = mount([question({ multiSelect: true })]);
  mouse(multi.component, "click", 4, lineIndex(multi.lines(), "1. Korean"));
  expect(multi.settled).toHaveLength(0);
  expect(multi.lines().join("\n")).toContain("> ☑ 1. Korean");
});

test("mouse Other and Skip activate their existing state transitions", () => {
  const other = mount([question()]);
  mouse(other.component, "click", 4, lineIndex(other.lines(), "Type something."));
  expect(other.lines().join("\n")).toContain("Your answer:");

  const skip = mount([question({ optional: true, allowOther: false })]);
  mouse(skip.component, "click", 4, lineIndex(skip.lines(), "Skip this question."));
  expect(skip.settled[0]!.answers).toEqual([{ id: "lang", kind: "skipped" }]);
});

test("a mouse tab click cancels custom editing before it navigates", () => {
  const { component, lines } = mount([question({ id: "a", label: "A" }), question({ id: "b", label: "B" })]);
  mouse(component, "click", 4, lineIndex(lines(), "Type something."));
  type(component, "stale");
  const tabY = lineIndex(lines(), "□ B");
  mouse(component, "click", lines()[tabY]!.indexOf("B"), tabY);
  expect(lines().join("\n")).not.toContain("Your answer:");
  expect(lines().join("\n")).toContain("> 1. Korean");
});

test("CJK tab layout stays finite at narrow widths and hit cells navigate the intended question", () => {
  const { component, settled, lines } = mount([
    question({ id: "a", label: "가나다라마바사라마바사", prompt: "First question" }),
    question({ id: "b", label: "둘", prompt: "Second question" }),
  ]);

  for (const width of [1, 2]) {
    for (const line of lines(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }

  const width = 18;
  const tabLines = lines(width);
  const secondTabY = lineIndex(tabLines, "둘");
  const secondTabX = cellX(tabLines[secondTabY]!, "둘");

  expect(mouse(component, "press", secondTabX, secondTabY, { width })).toMatchObject({ handled: true, focus: true });
  expect(lines(width).join("\n")).toContain("First question");
  mouse(component, "click", secondTabX, secondTabY, { width });
  expect(lines(width).join("\n")).toContain("Second question");
  expect(settled).toHaveLength(0);

  const submitLines = lines(width);
  const submitY = lineIndex(submitLines, "Submit");
  mouse(component, "click", cellX(submitLines[submitY]!, "Submit"), submitY, { width });
  expect(lines(width).join("\n")).toContain("Unanswered:");
  expect(settled).toHaveLength(0);
});

test("ANSI-styled tab geometry uses visible cells", () => {
  const ansiTheme = {
    fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[0m`,
    bg: (_color: string, text: string) => `\u001b[44m${text}\u001b[0m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
  };
  const { component, lines } = mount(
    [
      question({ id: "a", label: "Alpha", prompt: "Alpha question" }),
      question({ id: "b", label: "Beta", prompt: "Beta question" }),
    ],
    { theme: ansiTheme },
  );
  const width = 60;
  const tabLines = lines(width);
  const betaY = lineIndex(tabLines, "Beta");

  mouse(component, "click", cellX(tabLines[betaY]!, "Beta"), betaY, { width });
  expect(lines(width).join("\n")).toContain("Beta question");
});

test("drag, release, and non-left mouse buttons never activate options", () => {
  const { component, settled, lines } = mount([question()]);
  const y = lineIndex(lines(), "1. Korean");
  expect(mouse(component, "drag", 3, y)).toBeUndefined();
  expect(mouse(component, "release", 3, y)).toBeUndefined();
  expect(mouse(component, "click", 3, y, { button: "right" })).toBeUndefined();
  expect(settled).toHaveLength(0);
});

test("mouse wheel moves across the full option block and consumes its bounds", () => {
  const { component, lines } = mount([question({ multiSelect: true, options: makeOptions(30), allowOther: false })], {
    rows: 18,
  });
  const width = 60;
  const y = lineIndex(lines(width), "1. OPT 1");

  // The blank cells to the right of option text are part of the option block.
  expect(mouse(component, "wheel", width - 1, y, { width, wheelDelta: -99 })).toEqual({ handled: true, render: false });
  expect(mouse(component, "wheel", width - 1, y, { width, wheelDelta: 99 })).toEqual({ handled: true, render: true });
  expect(lines(width).join("\n")).toContain("> ☐ 2. OPT 2");

  // Overflow indicators share the block even though they are not option hits.
  const overflowY = lineIndex(lines(width), "↓");
  expect(mouse(component, "wheel", 1, overflowY, { width, wheelDelta: 99 })).toEqual({ handled: true, render: true });
  expect(lines(width).join("\n")).toContain("> ☐ 3. OPT 3");

  for (let index = 0; index < 20; index++) mouse(component, "wheel", 4, lineIndex(lines(), "> "), { wheelDelta: 1 });
  expect(lines().join("\n")).toContain("↑");
  expect(mouse(component, "wheel", 0, 0, { wheelDelta: 1 })).toBeUndefined();
});

test("mouse forwards editor clicks with local coordinates and parent focus", () => {
  const { component, settled, lines } = mount([question()]);
  mouse(component, "click", 4, lineIndex(lines(), "Type something."));
  type(component, "abc");
  const editorY = lineIndex(lines(), "abc");

  expect(mouse(component, "click", 1, editorY)).toMatchObject({ handled: true, focus: true });
  type(component, "X");
  component.handleInput(ENTER);
  expect(settled[0]!.answers[0]).toMatchObject({ value: "Xabc" });
});

test("an editor press supersedes a stale option press and preserves cursor positioning", () => {
  const { component, settled, lines } = mount([question()]);
  mouse(component, "click", 4, lineIndex(lines(), "Type something."));
  type(component, "abc");

  const optionLines = lines();
  const optionY = lineIndex(optionLines, "1. Korean");
  mouse(component, "press", cellX(optionLines[optionY]!, "Korean"), optionY);

  const editorY = lineIndex(lines(), "abc");
  mouse(component, "press", 1, editorY);
  expect(mouse(component, "click", 1, editorY)).toMatchObject({ handled: true, focus: true });
  type(component, "X");
  component.handleInput(ENTER);

  expect(settled[0]!.answers[0]).toMatchObject({ value: "Xabc" });
});

test("mouse geometry regenerates after width and terminal-row changes", () => {
  const { component, settled, tui, lines } = mount([question({ options: makeOptions(10), allowOther: false })], {
    rows: 40,
  });
  const width = 60;
  const oldY = lineIndex(lines(width), "10. OPT 10");

  // The old row is outside the new three-row viewport. A stale hit cache with
  // the same width but stale terminal-row generation would select option ten.
  tui.terminal.rows = 14;
  expect(mouse(component, "click", 4, oldY, { width })).toBeUndefined();
  expect(settled).toHaveLength(0);
  expect(lines(width).every((line) => visibleWidth(line) <= width)).toBe(true);
});

test("an invalidated press cannot activate a newly rendered option", () => {
  const { component, settled, lines } = mount([
    question({ id: "a", label: "A", prompt: "First question" }),
    question({ id: "b", label: "B", prompt: "Second question" }),
  ]);
  const width = 60;
  const firstLines = lines(width);
  const firstOptionY = lineIndex(firstLines, "1. Korean");

  mouse(component, "press", cellX(firstLines[firstOptionY]!, "Korean"), firstOptionY, { width });
  component.handleInput(TAB);
  const secondLines = lines(width);
  const secondOptionY = lineIndex(secondLines, "1. Korean");
  mouse(component, "click", cellX(secondLines[secondOptionY]!, "Korean"), secondOptionY, { width });

  expect(settled).toHaveLength(0);
  expect(lines(width).join("\n")).toContain("Second question");
});

test("a miss press followed by a keyboard state change cannot select a newly rendered option", () => {
  const { component, settled, lines } = mount([
    question({
      id: "a",
      label: "A",
      prompt: "A very long prompt that wraps onto a second line at this width".repeat(2),
    }),
    question({ id: "b", label: "B", prompt: "Second question" }),
  ]);
  const width = 60;
  component.handleInput(TAB);
  const secondLines = lines(width);
  const koreanY = lineIndex(secondLines, "1. Korean");
  const koreanX = cellX(secondLines[koreanY]!, "Korean");
  component.handleInput(LEFT);

  // The same cell is prompt text on the first tab, then an option on the
  // second tab. A state-changing key must fence that miss gesture.
  mouse(component, "press", koreanX, koreanY, { width });
  component.handleInput(TAB);
  mouse(component, "click", koreanX, koreanY, { width });

  expect(settled).toHaveLength(0);
  expect(lines(width).join("\n")).toContain("Second question");
});

test("a pending press is consumed after a resize or a click on another target", () => {
  const resized = mount([question({ options: makeOptions(4), allowOther: false })], { rows: 40 });
  const width = 60;
  const resizedLines = resized.lines(width);
  const koreanY = lineIndex(resizedLines, "1. OPT 1");
  const koreanX = cellX(resizedLines[koreanY]!, "OPT 1");
  mouse(resized.component, "press", koreanX, koreanY, { width });
  resized.tui.terminal.rows = 14;
  mouse(resized.component, "click", koreanX, koreanY, { width });
  expect(resized.settled).toHaveLength(0);

  const columnsOnly = mount([question({ options: makeOptions(4), allowOther: false })]);
  const columnsLines = columnsOnly.lines(width);
  const columnsY = lineIndex(columnsLines, "1. OPT 1");
  const columnsX = cellX(columnsLines[columnsY]!, "OPT 1");
  Object.assign(columnsOnly.tui.terminal, { columns: 80 });
  mouse(columnsOnly.component, "press", columnsX, columnsY, { width });
  Object.assign(columnsOnly.tui.terminal, { columns: 61 });
  mouse(columnsOnly.component, "click", columnsX, columnsY, { width });
  expect(columnsOnly.settled).toHaveLength(0);

  const differentTarget = mount([question({ allowOther: false })]);
  const targetLines = differentTarget.lines(width);
  const firstY = lineIndex(targetLines, "1. Korean");
  const secondY = lineIndex(targetLines, "2. English");
  mouse(differentTarget.component, "press", cellX(targetLines[firstY]!, "Korean"), firstY, { width });
  mouse(differentTarget.component, "click", cellX(targetLines[secondY]!, "English"), secondY, { width });
  expect(differentTarget.settled).toHaveLength(0);
});

test("input after settlement does not produce another result", () => {
  const { component, settled } = mount([question()]);

  component.handleInput(ENTER);
  expect(settled).toHaveLength(1);

  component.handleInput(ESCAPE);
  component.handleInput(ENTER);
  expect(settled).toHaveLength(1);
});
