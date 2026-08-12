// Tool parameter schema and untrusted-input normalization.
//
// The LLM supplies `questions` as arbitrary JSON, so every field is validated
// here before the TUI sees it. Validation returns an error string instead of
// throwing so the tool can report a normal error result. Display strings are
// sanitized at this boundary; nothing downstream re-checks them.

import { Type } from "typebox";
import {
  isValueLengthAllowed,
  MAX_DISPLAY_LENGTH,
  MAX_VALUE_LENGTH,
  sanitizeDisplayText,
  sanitizeValue,
} from "./sanitize.ts";
import type { Answer, Question, QuestionOption } from "./types.ts";

/** Upper bound on questions per call, so the tab bar stays readable. */
export const MAX_QUESTIONS = 20;
/** Upper bound on options per question, independent of the viewport size. */
export const MAX_OPTIONS = 50;
/** Upper bound on question id length. */
export const MAX_ID_LENGTH = 64;
/** Default code-point cap on free-text answers. */
export const DEFAULT_OTHER_MAX_LENGTH = 500;
/** Hard ceiling on a caller-supplied `otherMaxLength`. */
export const MAX_OTHER_MAX_LENGTH = 2000;

const QuestionOptionSchema = Type.Object({
  value: Type.String({ maxLength: MAX_VALUE_LENGTH }),
  label: Type.String(),
  description: Type.Optional(Type.String()),
});

const QuestionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH }),
  label: Type.Optional(Type.String()),
  prompt: Type.String(),
  options: Type.Array(QuestionOptionSchema, { minItems: 1, maxItems: MAX_OPTIONS }),
  multiSelect: Type.Optional(Type.Boolean()),
  allowOther: Type.Optional(Type.Boolean()),
  optional: Type.Optional(Type.Boolean()),
  requireReview: Type.Optional(Type.Boolean()),
  defaultValues: Type.Optional(Type.Array(Type.String({ maxLength: MAX_VALUE_LENGTH }), { maxItems: MAX_OPTIONS })),
  minSelections: Type.Optional(Type.Integer({ minimum: 1 })),
  maxSelections: Type.Optional(Type.Integer({ minimum: 1 })),
  otherLabel: Type.Optional(Type.String()),
  otherPlaceholder: Type.Optional(Type.String()),
  otherMaxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OTHER_MAX_LENGTH })),
});

export const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }),
});

export const DEFAULT_OTHER_LABEL = "Type something.";

/** Short display label for the skip entry of optional questions. */
export const SKIP_OPTION_LABEL = "Skip this question.";

type RawQuestion = {
  id?: unknown;
  label?: unknown;
  prompt?: unknown;
  options?: unknown;
  multiSelect?: unknown;
  allowOther?: unknown;
  optional?: unknown;
  requireReview?: unknown;
  defaultValues?: unknown;
  minSelections?: unknown;
  maxSelections?: unknown;
  otherLabel?: unknown;
  otherPlaceholder?: unknown;
  otherMaxLength?: unknown;
};

/** A positive integer within bounds, or `undefined` when absent, or an error. */
function readBoundedInteger(value: unknown, maximum: number): { ok: true; value: number | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    return { ok: false };
  }
  return { ok: true, value };
}

function normalizeOptions(rawOptions: unknown[], questionIndex: number): QuestionOption[] | string {
  if (rawOptions.length > MAX_OPTIONS) {
    return `Error: Question ${questionIndex + 1} has more than ${MAX_OPTIONS} options`;
  }

  const options: QuestionOption[] = [];
  const seenValues = new Set<string>();
  for (let optionIndex = 0; optionIndex < rawOptions.length; optionIndex++) {
    const rawOption = rawOptions[optionIndex];
    const position = `Option ${optionIndex + 1} for question ${questionIndex + 1}`;
    if (!rawOption || typeof rawOption !== "object") {
      return `Error: ${position} is invalid`;
    }
    const option = rawOption as { value?: unknown; label?: unknown; description?: unknown };
    if (
      typeof option.value !== "string" ||
      typeof option.label !== "string" ||
      (option.description !== undefined && typeof option.description !== "string")
    ) {
      return `Error: ${position} is invalid`;
    }
    if (!isValueLengthAllowed(option.value)) {
      return `Error: ${position} has a value longer than ${MAX_VALUE_LENGTH} characters`;
    }
    const value = sanitizeValue(option.value);
    if (seenValues.has(value)) {
      return `Error: ${position} repeats value "${sanitizeDisplayText(value, 40)}"`;
    }
    seenValues.add(value);
    options.push({
      value,
      label: sanitizeDisplayText(option.label),
      description: option.description === undefined ? undefined : sanitizeDisplayText(option.description),
    });
  }
  return options;
}

function normalizeQuestion(rawQuestion: unknown, questionIndex: number): Question | string {
  const position = `Question ${questionIndex + 1}`;
  if (!rawQuestion || typeof rawQuestion !== "object") return `Error: ${position} is invalid`;

  const question = rawQuestion as RawQuestion;
  if (typeof question.id !== "string" || typeof question.prompt !== "string") {
    return `Error: ${position} is invalid`;
  }
  const id = sanitizeValue(question.id).trim();
  if (!id || [...id].length > MAX_ID_LENGTH) return `Error: ${position} is invalid`;
  if (!Array.isArray(question.options) || question.options.length === 0) {
    return `Error: ${position} has no options`;
  }
  const options = normalizeOptions(question.options, questionIndex);
  if (typeof options === "string") return options;

  const multiSelect = question.multiSelect === true;

  const minSelections = readBoundedInteger(question.minSelections, options.length);
  if (!minSelections.ok) {
    return `Error: ${position} has an invalid minSelections`;
  }
  const maxSelections = readBoundedInteger(question.maxSelections, options.length);
  if (!maxSelections.ok) {
    return `Error: ${position} has an invalid maxSelections`;
  }
  const minimum = minSelections.value ?? 1;
  const maximum = maxSelections.value;
  if (maximum !== undefined && maximum < minimum) {
    return `Error: ${position} has maxSelections below minSelections`;
  }

  const otherMaxLength = readBoundedInteger(question.otherMaxLength, MAX_OTHER_MAX_LENGTH);
  if (!otherMaxLength.ok) {
    return `Error: ${position} has an invalid otherMaxLength`;
  }

  if (question.defaultValues !== undefined && !Array.isArray(question.defaultValues)) {
    return `Error: ${position} has invalid defaultValues`;
  }
  const rawDefaults = question.defaultValues ?? [];
  if (rawDefaults.length > MAX_OPTIONS) {
    return `Error: ${position} has more than ${MAX_OPTIONS} defaultValues`;
  }
  const knownValues = new Set(options.map((option) => option.value));
  const defaultValues: string[] = [];
  for (const rawDefault of rawDefaults) {
    if (typeof rawDefault !== "string") return `Error: ${position} has invalid defaultValues`;
    if (!isValueLengthAllowed(rawDefault)) {
      return `Error: ${position} has a defaultValues entry that matches no option`;
    }
    const value = sanitizeValue(rawDefault);
    if (!knownValues.has(value)) {
      return `Error: ${position} has a defaultValues entry that matches no option`;
    }
    if (!defaultValues.includes(value)) defaultValues.push(value);
  }
  if (!multiSelect && defaultValues.length > 1) {
    return `Error: ${position} is single-select and cannot have multiple defaultValues`;
  }
  if (maximum !== undefined && defaultValues.length > maximum) {
    return `Error: ${position} has more defaultValues than maxSelections allows`;
  }

  const label = typeof question.label === "string" ? sanitizeDisplayText(question.label, 80) : "";
  const otherLabel = typeof question.otherLabel === "string" ? sanitizeDisplayText(question.otherLabel, 80) : "";
  const otherPlaceholder =
    typeof question.otherPlaceholder === "string" ? sanitizeDisplayText(question.otherPlaceholder, 120) : undefined;

  return {
    id,
    label: label || id,
    prompt: sanitizeDisplayText(question.prompt, MAX_DISPLAY_LENGTH, true),
    options,
    multiSelect,
    allowOther: question.allowOther !== false,
    optional: question.optional === true,
    requireReview: question.requireReview === true,
    defaultValues,
    minSelections: minimum,
    maxSelections: maximum,
    otherLabel: otherLabel || DEFAULT_OTHER_LABEL,
    otherPlaceholder: otherPlaceholder || undefined,
    otherMaxLength: otherMaxLength.value ?? DEFAULT_OTHER_MAX_LENGTH,
  };
}

/**
 * Normalize untrusted tool parameters into a question list.
 *
 * Returns an error message string when the input is unusable. Question ids are
 * trimmed and must be unique and non-empty; `allowOther` defaults to enabled
 * and `multiSelect` defaults to disabled. Display strings are sanitized and
 * length-capped here.
 */
export function normalizeQuestions(params: unknown): Question[] | string {
  if (!params || typeof params !== "object" || !Array.isArray((params as { questions?: unknown }).questions)) {
    return "Error: No questions provided";
  }

  const rawQuestions = (params as { questions: unknown[] }).questions;
  if (rawQuestions.length === 0) {
    return "Error: No questions provided";
  }
  if (rawQuestions.length > MAX_QUESTIONS) {
    return `Error: More than ${MAX_QUESTIONS} questions provided`;
  }

  const questions: Question[] = [];
  const questionIds = new Set<string>();
  for (let questionIndex = 0; questionIndex < rawQuestions.length; questionIndex++) {
    const question = normalizeQuestion(rawQuestions[questionIndex], questionIndex);
    if (typeof question === "string") return question;
    if (questionIds.has(question.id)) return `Error: Question ${questionIndex + 1} is invalid`;
    questionIds.add(question.id);
    questions.push(question);
  }

  return questions;
}

/** Human-readable labels for one answer, joining multi-select selections. */
export function answerLabels(answer: Answer): string {
  if (answer.kind === "skipped") return "(skipped)";
  if (answer.kind !== "multi") return answer.label;
  const labels = answer.selections.map((selection) => selection.label);
  if (answer.custom) labels.push(answer.custom);
  return labels.join(", ");
}

/**
 * Machine values for one answer, in the same order as `answerLabels`.
 * Free-text answers contribute the typed text, which has no option value.
 */
export function answerValues(answer: Answer): string[] {
  switch (answer.kind) {
    case "single":
    case "custom":
      return [answer.value];
    case "multi": {
      const values = answer.selections.map((selection) => selection.value);
      if (answer.custom) values.push(answer.custom);
      return values;
    }
    case "skipped":
      return [];
  }
}
