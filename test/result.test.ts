import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { MAX_ID_LENGTH, MAX_OPTIONS, MAX_OTHER_MAX_LENGTH, MAX_QUESTIONS } from "../src/questions.ts";
import { QuestionnaireOutput, structuredResult } from "../src/result.ts";
import { MAX_DISPLAY_LENGTH, MAX_VALUE_LENGTH } from "../src/sanitize.ts";
import type { Answer } from "../src/types.ts";

const single: Answer = { id: "q", kind: "single", value: "v", label: "Label", index: 1 };
const output = (answer: unknown) => ({ answers: [answer], cancelled: false });

test("answer schema preserves normalized code-point ceilings including supplementary Unicode", () => {
  const longest: Answer = {
    id: "😀".repeat(MAX_ID_LENGTH),
    kind: "single",
    index: MAX_OPTIONS,
    value: "😀".repeat(MAX_VALUE_LENGTH),
    label: "😀".repeat(MAX_DISPLAY_LENGTH),
  };
  expect(Check(QuestionnaireOutput, output(longest))).toBe(true);
  const multi: Answer = {
    id: "q",
    kind: "multi",
    selections: Array.from({ length: MAX_OPTIONS }, (_, i) => ({
      value: longest.value,
      label: longest.label,
      index: i + 1,
    })),
    custom: "😀".repeat(MAX_OTHER_MAX_LENGTH),
  };
  expect(Check(QuestionnaireOutput, output(multi))).toBe(true);
  expect(
    Check(QuestionnaireOutput, output({ id: "q", kind: "custom", value: multi.custom, label: multi.custom })),
  ).toBe(true);
  expect(Check(QuestionnaireOutput, { answers: Array(MAX_QUESTIONS).fill(single), cancelled: false })).toBe(true);
});

test("answer schema rejects out-of-bounds strings, arrays, indices and incomplete variants", () => {
  for (const answer of [
    { ...single, id: "" },
    { ...single, id: "x".repeat(MAX_ID_LENGTH + 1) },
    { ...single, value: "x".repeat(MAX_VALUE_LENGTH + 1) },
    { ...single, label: "x".repeat(MAX_DISPLAY_LENGTH + 1) },
    { ...single, index: 0 },
    { ...single, index: MAX_OPTIONS + 1 },
    { ...single, index: 1.5 },
    { id: "q", kind: "single", value: "v" },
    { id: "q", kind: "custom", value: "", label: "" },
    { id: "q", kind: "custom", value: "x".repeat(MAX_OTHER_MAX_LENGTH + 1), label: "x" },
    { id: "q", kind: "multi", selections: [], custom: "x".repeat(MAX_OTHER_MAX_LENGTH + 1) },
    { id: "q", kind: "multi", selections: Array(MAX_OPTIONS + 1).fill({ value: "v", label: "l", index: 1 }) },
    { id: "q", kind: "multi", selections: [{ value: "v", label: "l", index: 0 }] },
    { id: "q", kind: "multi" },
    { id: "q", kind: "skipped", value: "v" },
    { id: "q", kind: "unknown" },
  ])
    expect(Check(QuestionnaireOutput, output(answer))).toBe(false);
  expect(Check(QuestionnaireOutput, { answers: Array(MAX_QUESTIONS + 1).fill(single), cancelled: false })).toBe(false);
  expect(Check(QuestionnaireOutput, { answers: [], cancelled: true, cancelReason: "unknown" })).toBe(false);
  expect(Check(QuestionnaireOutput, { answers: [], cancelled: false, questions: [] })).toBe(false);
});

test("compact projection detaches every answer variant and never adds absent cancelReason", () => {
  const answers: Answer[] = [
    single,
    { id: "c", kind: "custom", value: "typed", label: "typed" },
    { id: "s", kind: "skipped" },
  ];
  const result = structuredResult({ questions: [], answers, cancelled: false });
  expect(Object.keys(result).sort()).toEqual(["answers", "cancelled"]);
  expect(result.answers).toEqual(answers);
  result.answers.forEach((answer, index) => {
    expect(answer).not.toBe(answers[index]);
  });
  for (const reason of ["user", "aborted", "unavailable", "invalid"] as const) {
    expect(
      Check(
        QuestionnaireOutput,
        structuredResult({ questions: [], answers: [], cancelled: true, cancelReason: reason }),
      ),
    ).toBe(true);
  }
});
