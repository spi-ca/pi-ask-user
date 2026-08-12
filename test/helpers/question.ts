// Question factory for tests.
//
// Mirrors the defaults `normalizeQuestions` applies, so a test only states the
// fields it cares about and stays unaffected by new optional fields.

import { DEFAULT_OTHER_LABEL, DEFAULT_OTHER_MAX_LENGTH } from "../../src/questions.ts";
import type { Question } from "../../src/types.ts";

export function makeQuestion(overrides: Partial<Question> = {}): Question {
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
    optional: false,
    requireReview: false,
    defaultValues: [],
    minSelections: 1,
    otherLabel: DEFAULT_OTHER_LABEL,
    otherMaxLength: DEFAULT_OTHER_MAX_LENGTH,
    ...overrides,
  };
}

/** Option list of `count` entries, for viewport and filter tests. */
export function makeOptions(count: number, prefix = "opt"): Question["options"] {
  return Array.from({ length: count }, (_unused, index) => ({
    value: `${prefix}${index + 1}`,
    label: `${prefix.toUpperCase()} ${index + 1}`,
  }));
}
