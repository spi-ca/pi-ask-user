import { expect, test } from "bun:test";
import {
  CANCELLED_MESSAGE,
  callLabels,
  errorResult,
  formatAnswerLine,
  formatCancelledText,
  formatResultText,
  MAX_CALL_LINE_LABEL_LENGTH,
  MAX_CALL_LINE_LABELS,
} from "../src/tool.ts";
import type { Question, QuestionnaireResult } from "../src/types.ts";
import { makeQuestion } from "./helpers/question.ts";

function question(overrides: Partial<Question> = {}): Question {
  return makeQuestion({ options: [{ value: "ko", label: "Korean" }], ...overrides });
}

test("errorResult reports the message as a cancelled questionnaire", () => {
  const result = errorResult("Error: nope");
  expect(result.content).toEqual([{ type: "text", text: "Error: nope" }]);
  expect(result.details).toEqual({
    questions: [],
    answers: [],
    cancelled: true,
    cancelReason: "invalid",
  });
});

test("errorResult carries the cancel reason it was given", () => {
  expect(errorResult("Error: no UI", [], "unavailable").details.cancelReason).toBe("unavailable");
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
  expect(formatResultText(result)).toBe("A: Korean [ko]\nB: Korean, English [ko, en]");
});

test("formatAnswerLine appends values only when they differ from the labels", () => {
  const target = question({ id: "a", label: "A" });
  expect(formatAnswerLine(target, { id: "a", kind: "single", value: "ko", label: "Korean", index: 1 })).toBe(
    "A: Korean [ko]",
  );
  expect(formatAnswerLine(target, { id: "a", kind: "single", value: "Korean", label: "Korean", index: 1 })).toBe(
    "A: Korean",
  );
});

test("formatAnswerLine keeps free text unbracketed and marks a skip", () => {
  const target = question({ id: "a", label: "A" });
  expect(formatAnswerLine(target, { id: "a", kind: "custom", value: "Klingon", label: "Klingon" })).toBe("A: Klingon");
  expect(formatAnswerLine(target, { id: "a", kind: "skipped" })).toBe("A: (skipped)");
});

test("formatAnswerLine includes multi-select custom text among the values", () => {
  const target = question({ id: "a", label: "A" });
  expect(
    formatAnswerLine(target, {
      id: "a",
      kind: "multi",
      selections: [{ value: "ko", label: "Korean", index: 1 }],
      custom: "Klingon",
    }),
  ).toBe("A: Korean, Klingon [ko, Klingon]");
});

test("formatCancelledText names the reason and keeps partial answers", () => {
  const questions = [question({ id: "a", label: "A" })];
  expect(formatCancelledText({ questions, answers: [], cancelled: true, cancelReason: "user" })).toBe(
    `${CANCELLED_MESSAGE} (the user cancelled)`,
  );
  expect(formatCancelledText({ questions, answers: [], cancelled: true, cancelReason: "aborted" })).toContain(
    "the tool call was aborted",
  );
  expect(formatCancelledText({ questions, answers: [], cancelled: true, cancelReason: "unavailable" })).toContain(
    "no interactive UI was available",
  );

  const partial = formatCancelledText({
    questions,
    answers: [{ id: "a", kind: "single", value: "ko", label: "Korean", index: 1 }],
    cancelled: true,
    cancelReason: "user",
  });
  expect(partial).toContain("Answered so far:");
  expect(partial).toContain("A: Korean [ko]");
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

test("callLabels sanitizes unvalidated arguments before display", () => {
  expect(callLabels({ questions: [{ label: "La\u001b[2Jbel" }] }).labels).toBe("La[2Jbel");
  expect([...callLabels({ questions: [{ label: "L".repeat(200) }] }).labels].length).toBe(MAX_CALL_LINE_LABEL_LENGTH);
});

test("callLabels elides once past the label cap but still counts everything", () => {
  const questions = Array.from({ length: MAX_CALL_LINE_LABELS + 5 }, (_unused, index) => ({ label: `Q${index}` }));
  const { count, labels } = callLabels({ questions });

  expect(count).toBe(MAX_CALL_LINE_LABELS + 5);
  expect(labels.endsWith(", …")).toBe(true);
  expect(labels.split(", ")).toHaveLength(MAX_CALL_LINE_LABELS + 1);
});
