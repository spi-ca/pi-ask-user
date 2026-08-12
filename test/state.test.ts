import { expect, test } from "bun:test";
import { QuestionnaireState } from "../src/state.ts";
import type { Question, QuestionnaireResult } from "../src/types.ts";
import { makeOptions, makeQuestion as question } from "./helpers/question.ts";

function makeState(questions: Question[]) {
  const settled: QuestionnaireResult[] = [];
  const state = new QuestionnaireState({ questions, onSettled: (result) => settled.push(result) });
  return { state, settled };
}

/** Feed filter text one character at a time, as the component does. */
function type(state: QuestionnaireState, text: string): void {
  for (const character of text) state.appendFilter(character);
}

test("a single question submits immediately after it is answered", () => {
  const questions = [question()];
  const { state, settled } = makeState(questions);
  expect(state.hasMultipleQuestions).toBe(false);
  expect(state.hasReviewTab).toBe(false);
  expect(state.totalTabs).toBe(1);

  state.saveSingleAnswer(questions[0]!, 1);

  expect(settled).toHaveLength(1);
  expect(settled[0]!.cancelled).toBe(false);
  expect(settled[0]!.answers).toEqual([{ id: "lang", kind: "single", value: "en", label: "English", index: 2 }]);
});

test("requireReview gives a single question a review tab instead of submitting", () => {
  const questions = [question({ requireReview: true })];
  const { state, settled } = makeState(questions);
  expect(state.hasReviewTab).toBe(true);
  expect(state.totalTabs).toBe(2);

  state.saveSingleAnswer(questions[0]!, 0);
  expect(settled).toHaveLength(0);
  expect(state.onReviewTab).toBe(true);
  expect(state.allAnswered()).toBe(true);

  state.submit(false);
  expect(settled[0]!.answers).toHaveLength(1);
});

test("a single question without review still allows tab movement nowhere", () => {
  const { state } = makeState([question()]);
  state.moveTab(1);
  expect(state.currentTab).toBe(0);
  expect(state.onReviewTab).toBe(false);
});

test("multiple questions advance to the next tab and then to review", () => {
  const questions = [question({ id: "a", label: "A" }), question({ id: "b", label: "B" })];
  const { state, settled } = makeState(questions);

  state.saveSingleAnswer(questions[0]!, 0);
  expect(state.currentTab).toBe(1);
  expect(settled).toHaveLength(0);

  state.saveSingleAnswer(questions[1]!, 0);
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

test("settlement records the cancel reason and omits it on success", () => {
  const questions = [question({ id: "a" }), question({ id: "b" })];
  const aborted = makeState(questions);
  aborted.state.submit(true, "aborted");
  expect(aborted.settled[0]!.cancelReason).toBe("aborted");

  const done = makeState(questions);
  done.state.submit(false);
  expect(done.settled[0]!.cancelReason).toBeUndefined();
});

test("an optional question can be skipped and counts as answered", () => {
  const questions = [question({ id: "a", optional: true }), question({ id: "b" })];
  const { state, settled } = makeState(questions);

  state.skipQuestion(questions[0]!);
  expect(state.hasAnswer("a")).toBe(true);
  expect(state.currentTab).toBe(1);

  state.saveSingleAnswer(questions[1]!, 0);
  expect(state.allAnswered()).toBe(true);
  state.submit(false);
  expect(settled[0]!.answers[0]).toEqual({ id: "a", kind: "skipped" });
});

test("a required question cannot be skipped", () => {
  const target = question();
  const { state } = makeState([target]);
  state.skipQuestion(target);
  expect(state.hasAnswer("lang")).toBe(false);
});

test("maxSelections refuses an extra toggle and reports the max error", () => {
  const target = question({
    multiSelect: true,
    maxSelections: 1,
    options: makeOptions(3),
  });
  const { state } = makeState([target]);

  expect(state.toggleMultiSelection(target, 0)).toBe(true);
  expect(state.toggleMultiSelection(target, 1)).toBe(false);
  expect(state.selectionErrorFor("lang")).toBe("max");
  expect([...state.selectionsFor("lang")]).toEqual([0]);
});

test("minSelections blocks confirmation until enough options are chosen", () => {
  const target = question({ multiSelect: true, minSelections: 2, options: makeOptions(3) });
  const { state, settled } = makeState([target]);

  state.toggleMultiSelection(target, 0);
  expect(state.confirmMultiAnswer(target)).toBe(false);
  expect(state.selectionErrorFor("lang")).toBe("min");

  state.toggleMultiSelection(target, 2);
  expect(state.confirmMultiAnswer(target)).toBe(true);
  expect(settled).toHaveLength(1);
});

test("custom text counts toward maxSelections", () => {
  const target = question({ multiSelect: true, maxSelections: 1, options: makeOptions(3) });
  const { state, settled } = makeState([target]);

  state.toggleMultiSelection(target, 0);
  state.startCustomInput(target);
  state.submitCustomInput("extra");

  expect(settled).toHaveLength(0);
  expect(state.selectionErrorFor("lang")).toBe("max");
});

test("a rejected custom text is not stored and leaves no stale answer", () => {
  const target = question({ multiSelect: true, maxSelections: 1, options: makeOptions(3) });
  const { state, settled } = makeState([target]);

  state.toggleMultiSelection(target, 0);
  state.startCustomInput(target);
  state.submitCustomInput("extra");

  expect(state.customTextFor("lang")).toBeUndefined();
  expect(state.isEditing).toBe(false);
  expect(state.hasAnswer("lang")).toBe(false);
  expect(state.selectionErrorFor("lang")).toBe("max");
  expect(settled).toHaveLength(0);
});

test("a rejected custom text also drops an answer confirmed earlier", () => {
  const target = question({
    id: "a",
    multiSelect: true,
    maxSelections: 1,
    requireReview: true,
    options: makeOptions(3),
  });
  const { state, settled } = makeState([target]);

  state.toggleMultiSelection(target, 0);
  state.confirmMultiAnswer(target);
  expect(state.hasAnswer("a")).toBe(true);
  expect(state.onReviewTab).toBe(true);

  state.moveToTab(0);
  state.startCustomInput(target);
  state.submitCustomInput("extra");

  // Review must not be able to submit the value the user moved away from.
  expect(state.hasAnswer("a")).toBe(false);
  expect(state.allAnswered()).toBe(false);
  expect(state.selectionErrorFor("a")).toBe("max");
  expect(settled).toHaveLength(0);
});

test("an option toggle counts existing custom text toward maxSelections", () => {
  const target = question({ multiSelect: true, maxSelections: 1, options: makeOptions(3) });
  const { state } = makeState([target]);

  state.startCustomInput(target);
  state.submitCustomInput("only this");
  expect(state.customTextFor("lang")).toBe("only this");

  expect(state.toggleMultiSelection(target, 0)).toBe(false);
  expect(state.selectionErrorFor("lang")).toBe("max");
  expect([...state.selectionsFor("lang")]).toEqual([]);
});

test("selectAll and clearSelections cover the whole option list", () => {
  const target = question({ multiSelect: true, options: makeOptions(4) });
  const { state } = makeState([target]);

  expect(state.selectAll(target)).toBe(true);
  expect([...state.selectionsFor("lang")]).toEqual([0, 1, 2, 3]);

  state.clearSelections(target);
  expect([...state.selectionsFor("lang")]).toEqual([]);
});

test("selectAll is refused when it would exceed maxSelections", () => {
  const target = question({ multiSelect: true, maxSelections: 2, options: makeOptions(4) });
  const { state } = makeState([target]);

  expect(state.selectAll(target)).toBe(false);
  expect(state.selectionErrorFor("lang")).toBe("max");
  expect([...state.selectionsFor("lang")]).toEqual([]);
});

test("clearSelections also drops custom text and any confirmed answer", () => {
  const target = question({ multiSelect: true });
  const { state } = makeState([target]);

  state.toggleMultiSelection(target, 0);
  state.startCustomInput(target);
  state.submitCustomInput("extra");
  state.clearSelections(target);

  expect(state.customTextFor("lang")).toBeUndefined();
  expect(state.hasAnswer("lang")).toBe(false);
});

test("defaultValues preselect multi-select options and place the cursor there", () => {
  const target = question({ multiSelect: true, options: makeOptions(4), defaultValues: ["opt2", "opt3"] });
  const { state } = makeState([target]);

  expect([...state.selectionsFor("lang")]).toEqual([1, 2]);
  expect(state.optionIndex).toBe(1);
});

test("defaultValues place the cursor on a single-select question without answering it", () => {
  const target = question({ options: makeOptions(3), defaultValues: ["opt3"] });
  const { state } = makeState([target]);

  expect(state.optionIndex).toBe(2);
  expect(state.hasAnswer("lang")).toBe(false);
});

test("returning to an answered question restores the cursor to that answer", () => {
  const questions = [question({ id: "a", options: makeOptions(3) }), question({ id: "b" })];
  const { state } = makeState(questions);

  state.saveSingleAnswer(questions[0]!, 2);
  expect(state.currentTab).toBe(1);

  state.moveToTab(0);
  expect(state.optionIndex).toBe(2);
});

test("a free-text answer restores the cursor to the custom row", () => {
  const questions = [question({ id: "a", options: makeOptions(3) }), question({ id: "b" })];
  const { state } = makeState(questions);

  state.startCustomInput(questions[0]!);
  state.submitCustomInput("Klingon");
  state.moveToTab(0);

  // Three options plus the custom row.
  expect(state.currentOptions()[state.optionIndex]!.isOther).toBe(true);
});

test("a skipped answer restores the cursor to the skip row", () => {
  const questions = [
    question({ id: "a", optional: true, allowOther: false, options: makeOptions(3) }),
    question({ id: "b" }),
  ];
  const { state } = makeState(questions);

  state.skipQuestion(questions[0]!);
  state.moveToTab(0);

  expect(state.currentOptions()[state.optionIndex]!.isSkip).toBe(true);
});

test("a custom-only multi answer restores the cursor to the custom row", () => {
  const questions = [question({ id: "a", multiSelect: true }), question({ id: "b" })];
  const { state } = makeState(questions);

  state.startCustomInput(questions[0]!);
  state.submitCustomInput("Klingon");
  state.moveToTab(0);

  expect(state.currentOptions()[state.optionIndex]!.isOther).toBe(true);
});

test("answering jumps to the next unanswered question, wrapping if needed", () => {
  const questions = [question({ id: "a" }), question({ id: "b" }), question({ id: "c" })];
  const { state } = makeState(questions);

  state.moveToTab(1);
  state.saveSingleAnswer(questions[1]!, 0);
  expect(state.currentTab).toBe(2);

  state.saveSingleAnswer(questions[2]!, 0);
  expect(state.currentTab).toBe(0);

  state.saveSingleAnswer(questions[0]!, 0);
  expect(state.onReviewTab).toBe(true);
});

test("firstUnansweredTab points at the first gap and then disappears", () => {
  const questions = [question({ id: "a" }), question({ id: "b" })];
  const { state } = makeState(questions);

  expect(state.firstUnansweredTab()).toBe(0);
  state.saveSingleAnswer(questions[0]!, 0);
  expect(state.firstUnansweredTab()).toBe(1);
  state.saveSingleAnswer(questions[1]!, 0);
  expect(state.firstUnansweredTab()).toBeUndefined();
});

test("filtering narrows the visible options and clamps the cursor", () => {
  const target = question({
    options: [
      { value: "ko", label: "Korean" },
      { value: "en", label: "English" },
      { value: "ja", label: "Japanese" },
    ],
  });
  const { state } = makeState([target]);

  state.moveCursor(2);
  expect(state.optionIndex).toBe(2);

  state.startFiltering();
  expect(state.isFiltering).toBe(true);
  type(state, "kor");
  expect(state.filterFor("lang")).toBe("kor");
  // Korean plus the custom entry.
  expect(state.currentOptions()).toHaveLength(2);
  expect(state.optionIndex).toBeLessThanOrEqual(1);
});

test("a filtered selection uses the source option position, not the visible row", () => {
  const target = question({
    options: [
      { value: "ko", label: "Korean" },
      { value: "en", label: "English" },
      { value: "ja", label: "Japanese" },
    ],
  });
  const { state, settled } = makeState([target]);

  state.startFiltering();
  type(state, "japan");
  const [visible] = state.currentOptions();
  expect(visible!.optionIndex).toBe(2);

  state.saveSingleAnswer(target, visible!.optionIndex!);
  expect(settled[0]!.answers[0]).toEqual({
    id: "lang",
    kind: "single",
    value: "ja",
    label: "Japanese",
    index: 3,
  });
});

test("backspace shortens the filter and leaves filter mode when empty", () => {
  const { state } = makeState([question()]);

  state.startFiltering();
  type(state, "ko");
  state.backspaceFilter();
  expect(state.filterFor("lang")).toBe("k");

  state.backspaceFilter();
  expect(state.filterFor("lang")).toBe("");

  state.backspaceFilter();
  expect(state.isFiltering).toBe(false);
});

test("clearFilter restores the full option list", () => {
  const { state } = makeState([question()]);

  state.startFiltering();
  type(state, "zzz");
  expect(state.currentOptions()).toHaveLength(1);

  state.clearFilter();
  expect(state.isFiltering).toBe(false);
  expect(state.filterFor("lang")).toBe("");
  expect(state.currentOptions()).toHaveLength(3);
});

test("filter text is hardened and length-capped on the way in", () => {
  const { state } = makeState([question()]);

  state.startFiltering();
  state.appendFilter("\u001b");
  state.appendFilter("\u009b");
  state.appendFilter("a");
  expect(state.filterFor("lang")).toBe("a");

  for (let index = 0; index < 200; index++) state.appendFilter("b");
  expect([...state.filterFor("lang")].length).toBe(QuestionnaireState.MAX_FILTER_LENGTH);
});

test("moving tabs leaves filter mode but keeps the applied filter", () => {
  const questions = [question({ id: "a" }), question({ id: "b" })];
  const { state } = makeState(questions);

  state.startFiltering();
  type(state, "kor");
  state.moveTab(1);
  expect(state.isFiltering).toBe(false);

  state.moveTab(-1);
  expect(state.filterFor("a")).toBe("kor");
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

test("custom input on a single-select question is trimmed and settles the question", () => {
  const target = question();
  const { state, settled } = makeState([target]);

  state.startCustomInput(target);
  expect(state.submitCustomInput("  Klingon  ")).toBe(true);

  expect(state.isEditing).toBe(false);
  expect(settled[0]!.answers).toEqual([{ id: "lang", kind: "custom", value: "Klingon", label: "Klingon" }]);
});

test("custom input on a multi-select question is added alongside the selections", () => {
  const target = question({ multiSelect: true });
  const { state, settled } = makeState([target]);

  state.toggleMultiSelection(target, 0);
  state.startCustomInput(target);
  expect(state.submitCustomInput("  Klingon  ")).toBe(true);

  expect(state.isEditing).toBe(false);
  expect([...state.selectionsFor("lang")]).toEqual([0]);
  expect(state.customTextFor("lang")).toBe("Klingon");
  expect(settled[0]!.answers).toEqual([
    {
      id: "lang",
      kind: "multi",
      selections: [{ value: "ko", label: "Korean", index: 1 }],
      custom: "Klingon",
    },
  ]);
});

test("custom text alone satisfies a multi-select question", () => {
  const target = question({ multiSelect: true });
  const { state, settled } = makeState([target]);

  state.startCustomInput(target);
  state.submitCustomInput("Klingon");

  expect(settled[0]!.answers).toEqual([{ id: "lang", kind: "multi", selections: [], custom: "Klingon" }]);
});

test("custom input is capped at the question's otherMaxLength", () => {
  const target = question({ otherMaxLength: 5 });
  const { state, settled } = makeState([target]);

  state.startCustomInput(target);
  state.submitCustomInput("abcdefghij");

  expect(settled[0]!.answers[0]).toEqual({ id: "lang", kind: "custom", value: "abcd\u2026", label: "abcd\u2026" });
});

test("custom input strips control characters", () => {
  const target = question();
  const { state, settled } = makeState([target]);

  state.startCustomInput(target);
  state.submitCustomInput("ko\u001b[2Jrean");

  expect(settled[0]!.answers[0]).toMatchObject({ value: "ko[2Jrean" });
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

  state.saveSingleAnswer(questions[0]!, 0);
  state.submit(true);

  expect(settled[0]!.cancelled).toBe(true);
  expect(settled[0]!.answers).toHaveLength(1);
  expect(settled[0]!.answers[0]!.id).toBe("a");
});

test("answers are returned in question order regardless of answer order", () => {
  const questions = [question({ id: "a" }), question({ id: "b" }), question({ id: "c" })];
  const { state } = makeState(questions);

  state.currentTab = 2;
  state.saveSingleAnswer(questions[2]!, 0);
  state.currentTab = 0;
  state.saveSingleAnswer(questions[0]!, 0);

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
