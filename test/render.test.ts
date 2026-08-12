import { expect, test } from "bun:test";
import {
  answerPrefix,
  buildRenderOptions,
  clampViewportOffset,
  filterRenderOptions,
  formatAnswerSummary,
  hasRealOptions,
  helpText,
  MAX_VISIBLE_OPTIONS,
  MIN_VISIBLE_OPTIONS,
  missingAnswerLabels,
  OTHER_OPTION_LABEL,
  OTHER_OPTION_VALUE,
  optionRowText,
  overflowText,
  SKIP_OPTION_LABEL,
  SKIP_OPTION_VALUE,
  selectionBoundsText,
  selectionCountText,
  selectionErrorText,
  viewportOverflow,
  visibleOptionCount,
  wrapLines,
  wrapLinesWithPrefix,
} from "../src/render.ts";
import type { Answer } from "../src/types.ts";
import { makeQuestion as question } from "./helpers/question.ts";

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

test("buildRenderOptions tags real options with their source position", () => {
  const options = buildRenderOptions(question());
  expect(options[0]!.optionIndex).toBe(0);
  expect(options[1]!.optionIndex).toBe(1);
  expect(options[2]!.optionIndex).toBeUndefined();
});

test("buildRenderOptions appends a skip entry for optional questions", () => {
  const options = buildRenderOptions(question({ optional: true, allowOther: false }));
  expect(options).toHaveLength(3);
  expect(options[2]).toEqual({ value: SKIP_OPTION_VALUE, label: SKIP_OPTION_LABEL, isSkip: true });
});

test("buildRenderOptions uses a custom otherLabel", () => {
  const options = buildRenderOptions(question({ otherLabel: "Write your own" }));
  expect(options[2]!.label).toBe("Write your own");
});

test("filterRenderOptions matches label, value, and description but keeps synthetic rows", () => {
  const options = buildRenderOptions(
    question({
      optional: true,
      options: [
        { value: "ko", label: "Korean", description: "hangul" },
        { value: "en", label: "English" },
      ],
    }),
  );

  expect(filterRenderOptions(options, "kor").map((option) => option.value)).toEqual([
    "ko",
    OTHER_OPTION_VALUE,
    SKIP_OPTION_VALUE,
  ]);
  expect(filterRenderOptions(options, "EN").map((option) => option.value)).toContain("en");
  expect(filterRenderOptions(options, "hangul").map((option) => option.value)).toContain("ko");
  expect(filterRenderOptions(options, "zzz").map((option) => option.value)).toEqual([
    OTHER_OPTION_VALUE,
    SKIP_OPTION_VALUE,
  ]);
  expect(filterRenderOptions(options, "   ")).toBe(options);
});

test("hasRealOptions ignores synthetic rows", () => {
  const options = buildRenderOptions(question({ optional: true }));
  expect(hasRealOptions(options)).toBe(true);
  expect(hasRealOptions(filterRenderOptions(options, "zzz"))).toBe(false);
});

test("visibleOptionCount stays within bounds for any terminal height", () => {
  expect(visibleOptionCount(undefined)).toBe(MAX_VISIBLE_OPTIONS);
  expect(visibleOptionCount(200)).toBe(MAX_VISIBLE_OPTIONS);
  expect(visibleOptionCount(1)).toBe(MIN_VISIBLE_OPTIONS);
  expect(visibleOptionCount(Number.NaN)).toBe(MAX_VISIBLE_OPTIONS);
  const middle = visibleOptionCount(18);
  expect(middle).toBeGreaterThanOrEqual(MIN_VISIBLE_OPTIONS);
  expect(middle).toBeLessThanOrEqual(MAX_VISIBLE_OPTIONS);
});

test("clampViewportOffset keeps the cursor visible with minimal movement", () => {
  expect(clampViewportOffset(4, 3, 10, 0)).toBe(0);
  expect(clampViewportOffset(20, 0, 5, 7)).toBe(0);
  expect(clampViewportOffset(20, 12, 5, 0)).toBe(8);
  expect(clampViewportOffset(20, 9, 5, 8)).toBe(8);
  expect(clampViewportOffset(20, 19, 5, 0)).toBe(15);
  expect(clampViewportOffset(20, 5, 0, 3)).toBe(0);
});

test("viewportOverflow reports hidden rows on both sides", () => {
  expect(viewportOverflow(4, 0, 10)).toEqual({ above: 0, below: 0 });
  expect(viewportOverflow(20, 0, 5)).toEqual({ above: 0, below: 15 });
  expect(viewportOverflow(20, 8, 5)).toEqual({ above: 8, below: 7 });
  expect(viewportOverflow(20, 15, 5)).toEqual({ above: 15, below: 0 });
});

test("overflowText points in the hidden direction", () => {
  expect(overflowText("above", 3)).toBe("↑ 3 more");
  expect(overflowText("below", 12)).toBe("↓ 12 more");
});

test("selectionErrorText describes the violated bound", () => {
  expect(selectionErrorText(question({ multiSelect: true }), "min")).toBe(
    "Select at least one option before continuing",
  );
  expect(selectionErrorText(question({ multiSelect: true, minSelections: 2 }), "min")).toBe(
    "Select at least 2 options before continuing",
  );
  expect(selectionErrorText(question({ multiSelect: true, maxSelections: 1 }), "max")).toBe("Select at most 1 option");
  expect(selectionErrorText(question({ multiSelect: true, maxSelections: 2 }), "max")).toBe("Select at most 2 options");
});

test("selectionBoundsText only appears for bounded questions", () => {
  expect(selectionBoundsText(question({ multiSelect: true }))).toBeUndefined();
  expect(selectionBoundsText(question({ multiSelect: true, minSelections: 2 }))).toBe("Choose at least 2");
  expect(selectionBoundsText(question({ multiSelect: true, maxSelections: 2 }))).toBe("Choose 1–2");
  expect(selectionBoundsText(question({ multiSelect: true, minSelections: 2, maxSelections: 2 }))).toBe(
    "Choose exactly 2",
  );
});

test("selectionCountText appends bounds when present", () => {
  expect(selectionCountText(1, question({ multiSelect: true }))).toBe("1 selected");
  expect(selectionCountText(1, question({ multiSelect: true, maxSelections: 2 }))).toBe("1 selected • Choose 1–2");
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
  expect(answerPrefix({ id: "a", kind: "skipped" })).toBe("");
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
  const answers = new Map<string, Answer>([["b", { id: "b", kind: "single", value: "v", label: "l", index: 1 }]]);
  expect(missingAnswerLabels([first, second, third], answers)).toEqual(["A", "C"]);
});

test("a skipped question counts as answered for the missing list", () => {
  const answers = new Map<string, Answer>([["a", { id: "a", kind: "skipped" }]]);
  expect(missingAnswerLabels([question({ id: "a", label: "A" })], answers)).toEqual([]);
});

test("helpText adapts to multi-question, multi-select, and filter modes", () => {
  expect(helpText({ hasMultipleQuestions: false, multiSelect: false })).toBe(
    "↑↓ navigate • 1-9 jump • Enter select • Esc cancel",
  );
  expect(helpText({ hasMultipleQuestions: false, multiSelect: true })).toBe(
    "↑↓ navigate • 1-9 jump • Space toggle • a all • c clear • Enter confirm • Esc cancel",
  );
  expect(helpText({ hasMultipleQuestions: true, multiSelect: false })).toBe(
    "Tab/←→ navigate • ↑↓ select • 1-9 jump • Enter select • Esc cancel",
  );
  expect(helpText({ hasMultipleQuestions: false, multiSelect: false, canFilter: true })).toContain("/ filter");
  expect(helpText({ hasMultipleQuestions: false, multiSelect: false, filterActive: true })).toBe(
    "Type to filter • ↑↓ select • Enter choose • Esc clear filter",
  );
});

test("helpText uses the key labels it is given", () => {
  const text = helpText({
    hasMultipleQuestions: false,
    multiSelect: false,
    keys: { confirm: "Ctrl+M", cancel: "Ctrl+C" },
  });
  expect(text).toBe("↑↓ navigate • 1-9 jump • Ctrl+M select • Ctrl+C cancel");
});

test("optionRowText numbers options from 1 and marks the editing custom entry", () => {
  expect(optionRowText({ value: "ko", label: "Korean" }, 0, "", false)).toBe("1. Korean");
  expect(optionRowText({ value: "ko", label: "Korean" }, 1, "☑ ", false)).toBe("☑ 2. Korean");
  expect(optionRowText({ value: OTHER_OPTION_VALUE, label: "Other", isOther: true }, 2, "", true)).toBe("3. Other ✎");
  expect(optionRowText({ value: OTHER_OPTION_VALUE, label: "Other", isOther: true }, 2, "", false)).toBe("3. Other");
});
