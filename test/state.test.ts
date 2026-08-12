import { expect, test } from "bun:test";
import { QuestionnaireState } from "../src/state.ts";
import type { Question, QuestionnaireResult } from "../src/types.ts";

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: "lang",
    label: "Language",
    prompt: "Pick one",
    options: [
      { value: "ko", label: "Korean" },
      { value: "en", label: "English" },
    ],
    multiSelect: false,
    allowOther: true,
    ...overrides,
  };
}

function makeState(questions: Question[]) {
  const settled: QuestionnaireResult[] = [];
  const state = new QuestionnaireState({ questions, onSettled: (result) => settled.push(result) });
  return { state, settled };
}

test("a single question submits immediately after it is answered", () => {
  const questions = [question()];
  const { state, settled } = makeState(questions);
  expect(state.hasMultipleQuestions).toBe(false);
  expect(state.totalTabs).toBe(2);

  state.saveSingleAnswer(questions[0]!, questions[0]!.options[1]!, 1);

  expect(settled).toHaveLength(1);
  expect(settled[0]!.cancelled).toBe(false);
  expect(settled[0]!.answers).toEqual([
    { id: "lang", kind: "single", value: "en", label: "English", index: 2 },
  ]);
});

test("multiple questions advance to the next tab and then to review", () => {
  const questions = [question({ id: "a", label: "A" }), question({ id: "b", label: "B" })];
  const { state, settled } = makeState(questions);

  state.saveSingleAnswer(questions[0]!, questions[0]!.options[0]!, 0);
  expect(state.currentTab).toBe(1);
  expect(settled).toHaveLength(0);

  state.saveSingleAnswer(questions[1]!, questions[1]!.options[0]!, 0);
  expect(state.currentTab).toBe(2);
  expect(state.onReviewTab).toBe(true);
  expect(state.allAnswered()).toBe(true);
  expect(settled).toHaveLength(0);

  state.submit(false);
  expect(settled[0]!.answers).toHaveLength(2);
});

test("tab navigation wraps through the review tab and resets the cursor", () => {
  const questions = [question({ id: "a" }), question({ id: "b" })];
  const { state } = makeState(questions);

  state.moveCursor(1);
  expect(state.optionIndex).toBe(1);

  state.moveTab(1);
  expect(state.currentTab).toBe(1);
  expect(state.optionIndex).toBe(0);

  state.moveTab(1);
  expect(state.onReviewTab).toBe(true);
  state.moveTab(1);
  expect(state.currentTab).toBe(0);
  state.moveTab(-1);
  expect(state.currentTab).toBe(2);
});

test("tab navigation is disabled for a single question", () => {
  const { state } = makeState([question()]);
  state.moveTab(1);
  expect(state.currentTab).toBe(0);
});

test("the cursor is clamped to the option list including the custom entry", () => {
  const { state } = makeState([question()]);
  state.moveCursor(-1);
  expect(state.optionIndex).toBe(0);
  state.moveCursor(10);
  expect(state.optionIndex).toBe(2);
});

test("multi-select requires at least one option and returns sorted 1-based selections", () => {
  const target = question({ multiSelect: true });
  const { state, settled } = makeState([target]);

  expect(state.confirmMultiAnswer(target)).toBe(false);
  expect(state.multiErrorFor(target.id)).toBe(true);
  expect(settled).toHaveLength(0);

  state.toggleMultiSelection(target, 1);
  state.toggleMultiSelection(target, 0);
  expect(state.multiErrorFor(target.id)).toBe(false);
  expect(state.confirmMultiAnswer(target)).toBe(true);

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

test("toggling a multi-select option clears a previously confirmed answer", () => {
  const target = question({ id: "a", multiSelect: true });
  const other = question({ id: "b" });
  const { state } = makeState([target, other]);

  state.toggleMultiSelection(target, 0);
  state.confirmMultiAnswer(target);
  expect(state.hasAnswer("a")).toBe(true);

  state.toggleMultiSelection(target, 0);
  expect(state.hasAnswer("a")).toBe(false);
  expect([...state.selectionsFor("a")]).toEqual([]);
});

test("blank custom input is rejected and keeps edit mode active", () => {
  const target = question();
  const { state, settled } = makeState([target]);

  state.startCustomInput(target);
  expect(state.isEditing).toBe(true);
  expect(state.editingId).toBe("lang");

  expect(state.submitCustomInput("   ")).toBe(false);
  expect(state.customErrorFor("lang")).toBe(true);
  expect(state.isEditing).toBe(true);
  expect(settled).toHaveLength(0);

  state.clearCustomError();
  expect(state.customErrorFor("lang")).toBe(false);
});

test("custom input is trimmed, replaces multi-select state, and settles the question", () => {
  const target = question({ multiSelect: true });
  const { state, settled } = makeState([target]);

  state.toggleMultiSelection(target, 0);
  state.startCustomInput(target);
  expect(state.submitCustomInput("  Klingon  ")).toBe(true);

  expect(state.isEditing).toBe(false);
  expect([...state.selectionsFor("lang")]).toEqual([]);
  expect(settled[0]!.answers).toEqual([{ id: "lang", kind: "custom", value: "Klingon", label: "Klingon" }]);
});

test("cancelling custom input keeps the question unanswered", () => {
  const target = question();
  const { state, settled } = makeState([target]);

  state.startCustomInput(target);
  state.cancelCustomInput();

  expect(state.isEditing).toBe(false);
  expect(state.hasAnswer("lang")).toBe(false);
  expect(settled).toHaveLength(0);
});

test("submitCustomInput without an active edit does nothing", () => {
  const { state, settled } = makeState([question()]);
  expect(state.submitCustomInput("value")).toBe(false);
  expect(settled).toHaveLength(0);
});

test("settlement happens exactly once", () => {
  const { state, settled } = makeState([question({ id: "a" }), question({ id: "b" })]);

  state.submit(true);
  state.submit(false);
  state.submit(true);

  expect(settled).toHaveLength(1);
  expect(settled[0]!.cancelled).toBe(true);
  expect(state.isSettled).toBe(true);
});

test("cancelled results carry only the answers recorded so far", () => {
  const questions = [question({ id: "a" }), question({ id: "b" })];
  const { state, settled } = makeState(questions);

  state.saveSingleAnswer(questions[0]!, questions[0]!.options[0]!, 0);
  state.submit(true);

  expect(settled[0]!.cancelled).toBe(true);
  expect(settled[0]!.answers).toHaveLength(1);
  expect(settled[0]!.answers[0]!.id).toBe("a");
});

test("answers are returned in question order regardless of answer order", () => {
  const questions = [question({ id: "a" }), question({ id: "b" }), question({ id: "c" })];
  const { state } = makeState(questions);

  state.currentTab = 2;
  state.saveSingleAnswer(questions[2]!, questions[2]!.options[0]!, 0);
  state.currentTab = 0;
  state.saveSingleAnswer(questions[0]!, questions[0]!.options[0]!, 0);

  expect(state.answersInQuestionOrder().map((answer) => answer.id)).toEqual(["a", "c"]);
});

test("revision advances only on state mutations", () => {
  const target = question();
  const { state } = makeState([target]);

  const initial = state.revision;
  state.moveCursor(0);
  expect(state.revision).toBe(initial);

  state.moveCursor(1);
  expect(state.revision).toBeGreaterThan(initial);
});
