import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createQuestionnaireComponent } from "../src/component.ts";
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

function mount(questions: Question[], options: { rows?: number; keybindings?: unknown } = {}) {
  const tui = fakeTui(80, options.rows ?? 40);
  const settled: QuestionnaireResult[] = [];
  const component = createQuestionnaireComponent({
    questions,
    tui: tui as never,
    theme: fakeTheme(),
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

test("the cursor stops at both ends of the option list", () => {
  const { component, settled } = mount([question()]);

  component.handleInput(UP);
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

test("input after settlement does not produce another result", () => {
  const { component, settled } = mount([question()]);

  component.handleInput(ENTER);
  expect(settled).toHaveLength(1);

  component.handleInput(ESCAPE);
  component.handleInput(ENTER);
  expect(settled).toHaveLength(1);
});
