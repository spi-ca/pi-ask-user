import { expect, test } from "bun:test";
import {
  answerPrefix,
  buildRenderOptions,
  formatAnswerSummary,
  helpText,
  missingAnswerLabels,
  optionRowText,
  OTHER_OPTION_LABEL,
  OTHER_OPTION_VALUE,
  wrapLines,
  wrapLinesWithPrefix,
} from "../src/render.ts";
import type { Answer, Question } from "../src/types.ts";

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

test("wrapLines never exceeds the requested width", () => {
  const lines = wrapLines("alpha beta gamma delta epsilon", 10);
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(10);
});

test("wrapLines treats non-positive widths as width 1", () => {
  expect(wrapLines("abc", 0).every((line) => line.length <= 1)).toBe(true);
});

test("wrapLinesWithPrefix indents continuation lines to the prefix width", () => {
  const lines = wrapLinesWithPrefix("> ", "alpha beta gamma delta", 12);
  expect(lines[0]!.startsWith("> ")).toBe(true);
  for (const line of lines.slice(1)) expect(line.startsWith("  ")).toBe(true);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
});

test("wrapLinesWithPrefix falls back to plain wrapping when the prefix fills the width", () => {
  const lines = wrapLinesWithPrefix("     ", "text", 3);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(3);
});

test("buildRenderOptions appends the custom entry only when allowed", () => {
  const withOther = buildRenderOptions(question());
  expect(withOther).toHaveLength(3);
  expect(withOther[2]).toEqual({ value: OTHER_OPTION_VALUE, label: OTHER_OPTION_LABEL, isOther: true });

  expect(buildRenderOptions(question({ allowOther: false }))).toHaveLength(2);
  expect(buildRenderOptions(undefined)).toEqual([]);
});

test("buildRenderOptions does not mutate the source options", () => {
  const source = question();
  buildRenderOptions(source);
  expect(source.options).toHaveLength(2);
});

test("answerPrefix marks only free-text answers", () => {
  expect(answerPrefix({ id: "a", kind: "custom", value: "x", label: "x" })).toBe("(wrote) ");
  expect(answerPrefix({ id: "a", kind: "single", value: "x", label: "x", index: 1 })).toBe("");
  expect(answerPrefix({ id: "a", kind: "multi", selections: [] })).toBe("");
});

test("formatAnswerSummary uses the question label and falls back to the answer id", () => {
  const answer: Answer = { id: "lang", kind: "custom", value: "Klingon", label: "Klingon" };
  expect(formatAnswerSummary(question(), answer)).toBe("Language: (wrote) Klingon");
  expect(formatAnswerSummary(undefined, answer)).toBe("lang: (wrote) Klingon");
});

test("missingAnswerLabels reports unanswered questions in order", () => {
  const first = question({ id: "a", label: "A" });
  const second = question({ id: "b", label: "B" });
  const third = question({ id: "c", label: "C" });
  const answers = new Map<string, Answer>([
    ["b", { id: "b", kind: "single", value: "v", label: "l", index: 1 }],
  ]);
  expect(missingAnswerLabels([first, second, third], answers)).toEqual(["A", "C"]);
});

test("helpText adapts to multi-question and multi-select modes", () => {
  expect(helpText(false, false)).toBe("↑↓ navigate • Enter select • Esc cancel");
  expect(helpText(false, true)).toBe("↑↓ navigate • Space toggle • Enter confirm • Esc cancel");
  expect(helpText(true, false)).toBe("Tab/←→ navigate • ↑↓ select • Enter select • Esc cancel");
  expect(helpText(true, true)).toContain("Tab/←→ navigate");
});

test("optionRowText numbers options from 1 and marks the editing custom entry", () => {
  expect(optionRowText({ value: "ko", label: "Korean" }, 0, "", false)).toBe("1. Korean");
  expect(optionRowText({ value: "ko", label: "Korean" }, 1, "☑ ", false)).toBe("☑ 2. Korean");
  expect(optionRowText({ value: OTHER_OPTION_VALUE, label: "Other", isOther: true }, 2, "", true)).toBe("3. Other ✎");
  expect(optionRowText({ value: OTHER_OPTION_VALUE, label: "Other", isOther: true }, 2, "", false)).toBe("3. Other");
});
