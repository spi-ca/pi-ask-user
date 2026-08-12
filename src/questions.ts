// Tool parameter schema and untrusted-input normalization.
//
// The LLM supplies `questions` as arbitrary JSON, so every field is validated
// here before the TUI sees it. Validation returns an error string instead of
// throwing so the tool can report a normal error result.

import { Type } from "typebox";
import type { Answer, Question, QuestionOption } from "./types.ts";

const QuestionOptionSchema = Type.Object({
  value: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
});

const QuestionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.Optional(Type.String()),
  prompt: Type.String(),
  options: Type.Array(QuestionOptionSchema, { minItems: 1 }),
  multiSelect: Type.Optional(Type.Boolean()),
  allowOther: Type.Optional(Type.Boolean()),
});

export const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1 }),
});

/**
 * Normalize untrusted tool parameters into a question list.
 *
 * Returns an error message string when the input is unusable. Question ids are
 * trimmed and must be unique and non-empty; `allowOther` defaults to enabled
 * and `multiSelect` defaults to disabled.
 */
export function normalizeQuestions(params: unknown): Question[] | string {
  if (!params || typeof params !== "object" || !Array.isArray((params as { questions?: unknown }).questions)) {
    return "Error: No questions provided";
  }

  const rawQuestions = (params as { questions: unknown[] }).questions;
  if (rawQuestions.length === 0) {
    return "Error: No questions provided";
  }

  const questions: Question[] = [];
  const questionIds = new Set<string>();
  for (let questionIndex = 0; questionIndex < rawQuestions.length; questionIndex++) {
    const rawQuestion = rawQuestions[questionIndex];
    if (!rawQuestion || typeof rawQuestion !== "object") {
      return `Error: Question ${questionIndex + 1} is invalid`;
    }
    const question = rawQuestion as {
      id?: unknown;
      label?: unknown;
      prompt?: unknown;
      options?: unknown;
      multiSelect?: unknown;
      allowOther?: unknown;
    };
    if (typeof question.id !== "string" || typeof question.prompt !== "string") {
      return `Error: Question ${questionIndex + 1} is invalid`;
    }
    const id = question.id.trim();
    if (!id || questionIds.has(id)) {
      return `Error: Question ${questionIndex + 1} is invalid`;
    }
    questionIds.add(id);
    if (!Array.isArray(question.options) || question.options.length === 0) {
      return `Error: Question ${questionIndex + 1} has no options`;
    }

    const options: QuestionOption[] = [];
    for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
      const rawOption = question.options[optionIndex];
      if (!rawOption || typeof rawOption !== "object") {
        return `Error: Option ${optionIndex + 1} for question ${questionIndex + 1} is invalid`;
      }
      const option = rawOption as { value?: unknown; label?: unknown; description?: unknown };
      if (
        typeof option.value !== "string" ||
        typeof option.label !== "string" ||
        (option.description !== undefined && typeof option.description !== "string")
      ) {
        return `Error: Option ${optionIndex + 1} for question ${questionIndex + 1} is invalid`;
      }
      options.push({ value: option.value, label: option.label, description: option.description });
    }

    questions.push({
      id,
      label: typeof question.label === "string" && question.label ? question.label : id,
      prompt: question.prompt,
      options,
      multiSelect: question.multiSelect === true,
      allowOther: question.allowOther !== false,
    });
  }

  return questions;
}

/** Human-readable labels for one answer, joining multi-select selections. */
export function answerLabels(answer: Answer): string {
  return answer.kind === "multi" ? answer.selections.map((selection) => selection.label).join(", ") : answer.label;
}
