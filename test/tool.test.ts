import { expect, test } from "bun:test";
import { MAX_QUESTIONS } from "../src/questions.ts";
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

function questionsProxyWithLength(length: unknown): unknown[] {
  return new Proxy([], {
    get(target, property, receiver) {
      if (property === "length") return length;
      return Reflect.get(target, property, receiver);
    },
  });
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

test("callLabels fails closed when the questions getter throws", () => {
  const args = Object.defineProperty({}, "questions", {
    get() {
      throw new Error("malformed arguments");
    },
  });

  expect(callLabels(args)).toEqual({ count: 0, labels: "" });
});

test("callLabels skips an inspected slot getter that throws", () => {
  const questions: unknown[] = [];
  Object.defineProperty(questions, 0, {
    get() {
      throw new Error("malformed question");
    },
  });
  questions.length = 1;

  expect(callLabels({ questions })).toEqual({ count: 0, labels: "" });
});

test("callLabels skips a question without reading later fields when a getter throws", () => {
  let idReads = 0;
  const question = Object.defineProperties(
    {},
    {
      label: {
        get() {
          throw new Error("malformed label");
        },
      },
      id: {
        get() {
          idReads += 1;
          return "id";
        },
      },
    },
  );

  expect(callLabels({ questions: [question] })).toEqual({ count: 0, labels: "" });
  expect(idReads).toBe(0);
});

test("callLabels fails closed for revoked question and questions proxies", () => {
  const questionProxy = Proxy.revocable({}, {});
  const questionsProxy = Proxy.revocable([], {});
  questionProxy.revoke();
  questionsProxy.revoke();

  expect(callLabels({ questions: [questionProxy.proxy] })).toEqual({ count: 0, labels: "" });
  expect(callLabels({ questions: questionsProxy.proxy })).toEqual({ count: 0, labels: "" });
});

test("callLabels fails closed for a questions proxy with a Symbol length", () => {
  expect(callLabels({ questions: questionsProxyWithLength(Symbol("length")) })).toEqual({ count: 0, labels: "" });
});

test("callLabels fails closed for a questions proxy with a coercion-throwing length", () => {
  const throwingLength = {
    valueOf() {
      throw new Error("length coercion must not run");
    },
  };

  expect(callLabels({ questions: questionsProxyWithLength(throwingLength) })).toEqual({ count: 0, labels: "" });
});

test("callLabels elides once past the label cap but still counts everything", () => {
  const questions = Array.from({ length: MAX_CALL_LINE_LABELS + 5 }, (_unused, index) => ({ label: `Q${index}` }));
  const { count, labels } = callLabels({ questions });

  expect(count).toBe(MAX_CALL_LINE_LABELS + 5);
  expect(labels.endsWith(", …")).toBe(true);
  expect(labels.split(", ")).toHaveLength(MAX_CALL_LINE_LABELS + 1);
});

test("callLabels bounds oversized getter-backed arrays", () => {
  const questions: unknown[] = [];
  let reads = 0;
  for (let index = 0; index < MAX_QUESTIONS; index++) {
    Object.defineProperty(questions, index, {
      get() {
        reads += 1;
        return { label: `Q${index}` };
      },
    });
  }
  questions.length = MAX_QUESTIONS + 1;
  Object.defineProperty(questions, MAX_QUESTIONS, {
    get() {
      throw new Error("oversized input must not be read");
    },
  });

  const { count, labels } = callLabels({ questions });

  expect(reads).toBe(MAX_QUESTIONS);
  expect(count).toBe(`${MAX_QUESTIONS}+`);
  expect(labels).toBe(`${Array.from({ length: MAX_CALL_LINE_LABELS }, (_unused, index) => `Q${index}`).join(", ")}, …`);
});

test("callLabels does not count uninspected malformed oversized entries", () => {
  const questions: unknown[] = Array.from({ length: MAX_QUESTIONS }, () => null);
  questions.length = MAX_QUESTIONS + 1;
  Object.defineProperty(questions, MAX_QUESTIONS, {
    get() {
      throw new Error("oversized input must not be read");
    },
  });

  expect(callLabels({ questions })).toEqual({ count: "0+", labels: "" });
});
