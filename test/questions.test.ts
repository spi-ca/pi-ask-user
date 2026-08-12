import { expect, test } from "bun:test";
import {
  answerLabels,
  answerValues,
  DEFAULT_OTHER_LABEL,
  DEFAULT_OTHER_MAX_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  normalizeQuestions,
  QuestionnaireParams,
} from "../src/questions.ts";
import { MAX_VALUE_LENGTH } from "../src/sanitize.ts";
import type { Question } from "../src/types.ts";

function expectQuestions(params: unknown): Question[] {
  const result = normalizeQuestions(params);
  if (typeof result === "string") throw new Error(`expected questions, got: ${result}`);
  return result;
}

function expectError(params: unknown): string {
  const result = normalizeQuestions(params);
  if (typeof result !== "string") throw new Error("expected an error string");
  return result;
}

test("normalizes a minimal question and applies defaults", () => {
  const questions = expectQuestions({
    questions: [{ id: "lang", prompt: "Pick one", options: [{ value: "ko", label: "Korean" }] }],
  });

  expect(questions).toHaveLength(1);
  expect(questions[0]).toEqual({
    id: "lang",
    label: "lang",
    prompt: "Pick one",
    options: [{ value: "ko", label: "Korean", description: undefined }],
    multiSelect: false,
    allowOther: true,
    optional: false,
    requireReview: false,
    defaultValues: [],
    minSelections: 1,
    maxSelections: undefined,
    otherLabel: DEFAULT_OTHER_LABEL,
    otherPlaceholder: undefined,
    otherMaxLength: DEFAULT_OTHER_MAX_LENGTH,
  });
});

test("trims ids, keeps explicit labels, and honors explicit flags", () => {
  const questions = expectQuestions({
    questions: [
      {
        id: "  lang  ",
        label: "Language",
        prompt: "Pick some",
        options: [
          { value: "ko", label: "Korean", description: "기본" },
          { value: "en", label: "English" },
        ],
        multiSelect: true,
        allowOther: false,
      },
    ],
  });

  expect(questions[0]!.id).toBe("lang");
  expect(questions[0]!.label).toBe("Language");
  expect(questions[0]!.multiSelect).toBe(true);
  expect(questions[0]!.allowOther).toBe(false);
  expect(questions[0]!.options[0]!.description).toBe("기본");
});

test("falls back to the id when the label is an empty string", () => {
  const questions = expectQuestions({
    questions: [{ id: "lang", label: "", prompt: "Pick", options: [{ value: "ko", label: "Korean" }] }],
  });
  expect(questions[0]!.label).toBe("lang");
});

test("rejects missing, empty, and non-array question input", () => {
  expect(normalizeQuestions(undefined)).toBe("Error: No questions provided");
  expect(normalizeQuestions(null)).toBe("Error: No questions provided");
  expect(normalizeQuestions({})).toBe("Error: No questions provided");
  expect(normalizeQuestions({ questions: "lang" })).toBe("Error: No questions provided");
  expect(normalizeQuestions({ questions: [] })).toBe("Error: No questions provided");
});

test("rejects invalid question shapes with a 1-based position", () => {
  const valid = { id: "a", prompt: "p", options: [{ value: "v", label: "l" }] };
  expect(normalizeQuestions({ questions: [null] })).toBe("Error: Question 1 is invalid");
  expect(normalizeQuestions({ questions: [valid, { id: 1, prompt: "p", options: [] }] })).toBe(
    "Error: Question 2 is invalid",
  );
  expect(normalizeQuestions({ questions: [{ id: "a", options: [{ value: "v", label: "l" }] }] })).toBe(
    "Error: Question 1 is invalid",
  );
  expect(normalizeQuestions({ questions: [{ id: "   ", prompt: "p", options: [{ value: "v", label: "l" }] }] })).toBe(
    "Error: Question 1 is invalid",
  );
});

test("rejects duplicate ids after trimming", () => {
  const options = [{ value: "v", label: "l" }];
  expect(
    normalizeQuestions({
      questions: [
        { id: "lang", prompt: "p", options },
        { id: " lang ", prompt: "p", options },
      ],
    }),
  ).toBe("Error: Question 2 is invalid");
});

test("rejects questions without options", () => {
  expect(normalizeQuestions({ questions: [{ id: "a", prompt: "p" }] })).toBe("Error: Question 1 has no options");
  expect(normalizeQuestions({ questions: [{ id: "a", prompt: "p", options: [] }] })).toBe(
    "Error: Question 1 has no options",
  );
});

test("rejects invalid options with question and option positions", () => {
  const good = { value: "v", label: "l" };
  expect(normalizeQuestions({ questions: [{ id: "a", prompt: "p", options: [good, null] }] })).toBe(
    "Error: Option 2 for question 1 is invalid",
  );
  expect(normalizeQuestions({ questions: [{ id: "a", prompt: "p", options: [{ value: "v" }] }] })).toBe(
    "Error: Option 1 for question 1 is invalid",
  );
  expect(normalizeQuestions({ questions: [{ id: "a", prompt: "p", options: [{ ...good, description: 7 }] }] })).toBe(
    "Error: Option 1 for question 1 is invalid",
  );
});

test("answerLabels joins multi-select selections and passes through single labels", () => {
  expect(answerLabels({ id: "a", kind: "single", value: "ko", label: "Korean", index: 1 })).toBe("Korean");
  expect(answerLabels({ id: "a", kind: "custom", value: "Klingon", label: "Klingon" })).toBe("Klingon");
  expect(
    answerLabels({
      id: "a",
      kind: "multi",
      selections: [
        { value: "ko", label: "Korean", index: 1 },
        { value: "en", label: "English", index: 2 },
      ],
    }),
  ).toBe("Korean, English");
  expect(answerLabels({ id: "a", kind: "multi", selections: [] })).toBe("");
});

test("answerLabels appends multi-select custom text and marks skips", () => {
  expect(
    answerLabels({
      id: "a",
      kind: "multi",
      selections: [{ value: "ko", label: "Korean", index: 1 }],
      custom: "Klingon",
    }),
  ).toBe("Korean, Klingon");
  expect(answerLabels({ id: "a", kind: "skipped" })).toBe("(skipped)");
});

test("answerValues mirrors answerLabels order and is empty for a skip", () => {
  expect(answerValues({ id: "a", kind: "single", value: "ko", label: "Korean", index: 1 })).toEqual(["ko"]);
  expect(answerValues({ id: "a", kind: "custom", value: "Klingon", label: "Klingon" })).toEqual(["Klingon"]);
  expect(
    answerValues({
      id: "a",
      kind: "multi",
      selections: [
        { value: "ko", label: "Korean", index: 1 },
        { value: "en", label: "English", index: 2 },
      ],
      custom: "Klingon",
    }),
  ).toEqual(["ko", "en", "Klingon"]);
  expect(answerValues({ id: "a", kind: "skipped" })).toEqual([]);
});

test("strips terminal escapes and control characters from display strings", () => {
  const questions = expectQuestions({
    questions: [
      {
        id: "lang",
        label: "La\u001b[2Jbel",
        prompt: "Line\u0007one",
        options: [{ value: "ko", label: "Ko\u001b]0;evil\u0007rean", description: "a\u0008b" }],
      },
    ],
  });

  expect(questions[0]!.label).toBe("La[2Jbel");
  expect(questions[0]!.prompt).toBe("Lineone");
  expect(questions[0]!.options[0]!.label).toBe("Ko]0;evilrean");
  expect(questions[0]!.options[0]!.description).toBe("ab");
});

test("strips bidi overrides that could reorder displayed text", () => {
  const questions = expectQuestions({
    questions: [{ id: "a", prompt: "safe\u202edaeh", options: [{ value: "v", label: "l\u2066x\u2069" }] }],
  });
  expect(questions[0]!.prompt).toBe("safedaeh");
  expect(questions[0]!.options[0]!.label).toBe("lx");
});

test("keeps newlines in prompts but flattens them in labels", () => {
  const questions = expectQuestions({
    questions: [{ id: "a", label: "one\ntwo", prompt: "one\ntwo", options: [{ value: "v", label: "x\ny" }] }],
  });
  expect(questions[0]!.prompt).toBe("one\ntwo");
  expect(questions[0]!.label).toBe("one two");
  expect(questions[0]!.options[0]!.label).toBe("x y");
});

test("truncates over-long display strings instead of rejecting them", () => {
  const questions = expectQuestions({
    questions: [{ id: "a", prompt: "p".repeat(5000), options: [{ value: "v", label: "l".repeat(5000) }] }],
  });
  expect([...questions[0]!.prompt].length).toBe(1000);
  expect(questions[0]!.prompt.endsWith("\u2026")).toBe(true);
  expect([...questions[0]!.options[0]!.label].length).toBe(1000);
});

test("rejects over-long ids, values, and oversized collections", () => {
  const options = [{ value: "v", label: "l" }];
  expect(expectError({ questions: [{ id: "a".repeat(65), prompt: "p", options }] })).toBe(
    "Error: Question 1 is invalid",
  );
  expect(
    expectError({
      questions: [{ id: "a", prompt: "p", options: [{ value: "v".repeat(MAX_VALUE_LENGTH + 1), label: "l" }] }],
    }),
  ).toContain("longer than");
  expect(
    expectError({
      questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_unused, index) => ({
        id: `q${index}`,
        prompt: "p",
        options,
      })),
    }),
  ).toBe(`Error: More than ${MAX_QUESTIONS} questions provided`);
  expect(
    expectError({
      questions: [
        {
          id: "a",
          prompt: "p",
          options: Array.from({ length: MAX_OPTIONS + 1 }, (_unused, index) => ({
            value: `v${index}`,
            label: "l",
          })),
        },
      ],
    }),
  ).toBe(`Error: Question 1 has more than ${MAX_OPTIONS} options`);
});

test("rejects duplicate option values within one question", () => {
  expect(
    expectError({
      questions: [
        {
          id: "a",
          prompt: "p",
          options: [
            { value: "v", label: "first" },
            { value: "v", label: "second" },
          ],
        },
      ],
    }),
  ).toBe('Error: Option 2 for question 1 repeats value "v"');
});

test("normalizes the new optional question fields", () => {
  const questions = expectQuestions({
    questions: [
      {
        id: "a",
        prompt: "p",
        multiSelect: true,
        optional: true,
        requireReview: true,
        defaultValues: ["v2", "v2"],
        minSelections: 1,
        maxSelections: 2,
        otherLabel: "Write your own",
        otherPlaceholder: "free text",
        otherMaxLength: 40,
        options: [
          { value: "v1", label: "One" },
          { value: "v2", label: "Two" },
        ],
      },
    ],
  });

  expect(questions[0]).toMatchObject({
    optional: true,
    requireReview: true,
    defaultValues: ["v2"],
    minSelections: 1,
    maxSelections: 2,
    otherLabel: "Write your own",
    otherPlaceholder: "free text",
    otherMaxLength: 40,
  });
});

test("rejects selection bounds that cannot be satisfied", () => {
  const options = [
    { value: "v1", label: "One" },
    { value: "v2", label: "Two" },
  ];
  expect(expectError({ questions: [{ id: "a", prompt: "p", options, minSelections: 3 }] })).toBe(
    "Error: Question 1 has an invalid minSelections",
  );
  expect(expectError({ questions: [{ id: "a", prompt: "p", options, maxSelections: 0 }] })).toBe(
    "Error: Question 1 has an invalid maxSelections",
  );
  expect(expectError({ questions: [{ id: "a", prompt: "p", options, minSelections: 2, maxSelections: 1 }] })).toBe(
    "Error: Question 1 has maxSelections below minSelections",
  );
  expect(expectError({ questions: [{ id: "a", prompt: "p", options, minSelections: 1.5 }] })).toBe(
    "Error: Question 1 has an invalid minSelections",
  );
});

test("rejects defaultValues that do not match options or exceed the question mode", () => {
  const options = [
    { value: "v1", label: "One" },
    { value: "v2", label: "Two" },
  ];
  expect(expectError({ questions: [{ id: "a", prompt: "p", options, defaultValues: "v1" }] })).toBe(
    "Error: Question 1 has invalid defaultValues",
  );
  expect(expectError({ questions: [{ id: "a", prompt: "p", options, defaultValues: [1] }] })).toBe(
    "Error: Question 1 has invalid defaultValues",
  );
  expect(expectError({ questions: [{ id: "a", prompt: "p", options, defaultValues: ["nope"] }] })).toBe(
    "Error: Question 1 has a defaultValues entry that matches no option",
  );
  expect(expectError({ questions: [{ id: "a", prompt: "p", options, defaultValues: ["v1", "v2"] }] })).toBe(
    "Error: Question 1 is single-select and cannot have multiple defaultValues",
  );
  expect(
    expectError({
      questions: [{ id: "a", prompt: "p", options, multiSelect: true, maxSelections: 1, defaultValues: ["v1", "v2"] }],
    }),
  ).toBe("Error: Question 1 has more defaultValues than maxSelections allows");
});

test("rejects an out-of-range otherMaxLength", () => {
  const options = [{ value: "v", label: "l" }];
  expect(expectError({ questions: [{ id: "a", prompt: "p", options, otherMaxLength: 0 }] })).toBe(
    "Error: Question 1 has an invalid otherMaxLength",
  );
  expect(expectError({ questions: [{ id: "a", prompt: "p", options, otherMaxLength: 999999 }] })).toBe(
    "Error: Question 1 has an invalid otherMaxLength",
  );
});

test("parameter schema requires at least one question and one option", () => {
  // Read the serialized JSON Schema: typebox's static types do not surface
  // constraint keywords such as minItems.
  const schema = JSON.parse(JSON.stringify(QuestionnaireParams));
  expect(schema.required).toEqual(["questions"]);
  expect(schema.properties.questions.minItems).toBe(1);
  expect(schema.properties.questions.maxItems).toBe(MAX_QUESTIONS);

  const question = schema.properties.questions.items;
  expect(question.required).toEqual(["id", "prompt", "options"]);
  expect(question.properties.id.minLength).toBe(1);
  expect(question.properties.options.minItems).toBe(1);
  expect(question.properties.options.maxItems).toBe(MAX_OPTIONS);
  expect(question.properties.options.items.required).toEqual(["value", "label"]);
  expect(question.properties.options.items.properties.value.maxLength).toBe(MAX_VALUE_LENGTH);
  expect(Object.keys(question.properties)).toContain("minSelections");
  expect(Object.keys(question.properties)).toContain("maxSelections");
  expect(Object.keys(question.properties)).toContain("defaultValues");
  expect(Object.keys(question.properties)).toContain("optional");
  expect(Object.keys(question.properties)).toContain("requireReview");
});
