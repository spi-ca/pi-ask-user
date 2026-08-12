import { expect, test } from "bun:test";
import { callLabels, errorResult, formatResultText } from "../src/tool.ts";
import type { Question, QuestionnaireResult } from "../src/types.ts";

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: "lang",
    label: "Language",
    prompt: "Pick one",
    options: [{ value: "ko", label: "Korean" }],
    multiSelect: false,
    allowOther: true,
    ...overrides,
  };
}

test("errorResult reports the message as a cancelled questionnaire", () => {
  const result = errorResult("Error: nope");
  expect(result.content).toEqual([{ type: "text", text: "Error: nope" }]);
  expect(result.details).toEqual({ questions: [], answers: [], cancelled: true });
});

test("errorResult keeps the questions it was given", () => {
  const questions = [question()];
  expect(errorResult("Error: nope", questions).details.questions).toBe(questions);
});

test("formatResultText emits one labeled line per answer", () => {
  const result: QuestionnaireResult = {
    questions: [question({ id: "a", label: "A" }), question({ id: "b", label: "B" })],
    answers: [
      { id: "a", kind: "single", value: "ko", label: "Korean", index: 1 },
      {
        id: "b",
        kind: "multi",
        selections: [
          { value: "ko", label: "Korean", index: 1 },
          { value: "en", label: "English", index: 2 },
        ],
      },
    ],
    cancelled: false,
  };
  expect(formatResultText(result)).toBe("A: Korean\nB: Korean, English");
});

test("formatResultText falls back to the answer id when no question matches", () => {
  const result: QuestionnaireResult = {
    questions: [],
    answers: [{ id: "orphan", kind: "custom", value: "x", label: "x" }],
    cancelled: false,
  };
  expect(formatResultText(result)).toBe("orphan: x");
});

test("formatResultText is empty when nothing was answered", () => {
  expect(formatResultText({ questions: [], answers: [], cancelled: true })).toBe("");
});

test("callLabels prefers label, then id, then prompt", () => {
  expect(
    callLabels({
      questions: [{ label: "Language" }, { id: "region" }, { prompt: "Anything else?" }, {}],
    }),
  ).toEqual({ count: 4, labels: "Language, region, Anything else?, Question" });
});

test("callLabels ignores non-object entries and non-array input", () => {
  expect(callLabels({ questions: [null, "lang", { label: "A" }] })).toEqual({ count: 1, labels: "A" });
  expect(callLabels({ questions: "lang" })).toEqual({ count: 0, labels: "" });
  expect(callLabels(undefined)).toEqual({ count: 0, labels: "" });
  expect(callLabels("questions")).toEqual({ count: 0, labels: "" });
});
