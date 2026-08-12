import { expect, test } from "bun:test";
import { createQuestionnaireComponent } from "../src/component.ts";
import type { Question, QuestionnaireResult } from "../src/types.ts";
import { fakeTheme, fakeTui } from "./helpers/fake-theme.ts";

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const ENTER = "\r";
const ESCAPE = "\u001b";
const TAB = "\t";
const SPACE = " ";

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: "lang",
    label: "Language",
    prompt: "Pick a language",
    options: [
      { value: "ko", label: "Korean", description: "기본값" },
      { value: "en", label: "English" },
    ],
    multiSelect: false,
    allowOther: true,
    ...overrides,
  };
}

function mount(questions: Question[]) {
  const tui = fakeTui();
  const settled: QuestionnaireResult[] = [];
  const component = createQuestionnaireComponent({
    questions,
    tui: tui as never,
    theme: fakeTheme(),
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
  expect(output).toContain("↑↓ navigate • Enter select • Esc cancel");
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
  expect(settled[0]!.answers).toEqual([
    { id: "lang", kind: "single", value: "en", label: "English", index: 2 },
  ]);
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
  expect(lines().join("\n")).toContain("Unanswered: A, B");

  component.handleInput(ENTER);
  expect(settled).toHaveLength(0);
});

test("Escape on the review tab cancels", () => {
  const { component, settled } = mount([question({ id: "a" }), question({ id: "b" })]);

  component.handleInput(TAB);
  component.handleInput(TAB);
  component.handleInput(ESCAPE);

  expect(settled[0]!.cancelled).toBe(true);
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
