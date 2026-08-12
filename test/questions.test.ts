import { expect, test } from "bun:test";
import { answerLabels, normalizeQuestions, QuestionnaireParams } from "../src/questions.ts";
import type { Question } from "../src/types.ts";

function expectQuestions(params: unknown): Question[] {
  const result = normalizeQuestions(params);
  if (typeof result === "string") throw new Error(`expected questions, got: ${result}`);
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
  expect(
    normalizeQuestions({ questions: [{ id: "a", prompt: "p", options: [{ ...good, description: 7 }] }] }),
  ).toBe("Error: Option 1 for question 1 is invalid");
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

test("parameter schema requires at least one question and one option", () => {
  // Read the serialized JSON Schema: typebox's static types do not surface
  // constraint keywords such as minItems.
  const schema = JSON.parse(JSON.stringify(QuestionnaireParams));
  expect(schema.required).toEqual(["questions"]);
  expect(schema.properties.questions.minItems).toBe(1);

  const question = schema.properties.questions.items;
  expect(question.required).toEqual(["id", "prompt", "options"]);
  expect(question.properties.id.minLength).toBe(1);
  expect(question.properties.options.minItems).toBe(1);
  expect(question.properties.options.items.required).toEqual(["value", "label"]);
});
