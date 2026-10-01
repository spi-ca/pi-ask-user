// Compact machine-readable tool output. The public UI result retains questions;
// only the tool adds this detached answer projection, never presence payloads.

import { type Static, Type } from "typebox";
import { MAX_ID_LENGTH, MAX_OPTIONS, MAX_OTHER_MAX_LENGTH, MAX_QUESTIONS } from "./questions.ts";
import { MAX_DISPLAY_LENGTH, MAX_VALUE_LENGTH } from "./sanitize.ts";
import type { QuestionnaireResult } from "./types.ts";

const id = Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH });
const value = Type.String({ maxLength: MAX_VALUE_LENGTH });
const label = Type.String({ maxLength: MAX_DISPLAY_LENGTH });
const custom = Type.String({ minLength: 1, maxLength: MAX_OTHER_MAX_LENGTH });
const index = Type.Integer({ minimum: 1, maximum: MAX_OPTIONS });
const selection = Type.Object({ value, label, index }, { additionalProperties: false });

const answer = Type.Union([
  Type.Object({ id, kind: Type.Literal("single"), value, label, index }, { additionalProperties: false }),
  Type.Object(
    {
      id,
      kind: Type.Literal("multi"),
      selections: Type.Array(selection, { maxItems: MAX_OPTIONS }),
      custom: Type.Optional(custom),
    },
    { additionalProperties: false },
  ),
  Type.Object({ id, kind: Type.Literal("custom"), value: custom, label: custom }, { additionalProperties: false }),
  Type.Object({ id, kind: Type.Literal("skipped") }, { additionalProperties: false }),
]);

/** Bounds mirror normalization (JSON Schema string lengths count code points). */
export const QuestionnaireOutput = Type.Object(
  {
    answers: Type.Array(answer, { maxItems: MAX_QUESTIONS }),
    cancelled: Type.Boolean(),
    cancelReason: Type.Optional(
      Type.Union([Type.Literal("user"), Type.Literal("aborted"), Type.Literal("unavailable"), Type.Literal("invalid")]),
    ),
  },
  { additionalProperties: false },
);

export type StructuredQuestionnaireResult = Static<typeof QuestionnaireOutput>;

/** No question duplication or shared mutable answer/selection objects with details. */
export function structuredResult(result: QuestionnaireResult): StructuredQuestionnaireResult {
  return {
    answers: result.answers.map((answer) =>
      answer.kind === "multi"
        ? { ...answer, selections: answer.selections.map((selection) => ({ ...selection })) }
        : { ...answer },
    ),
    cancelled: result.cancelled,
    ...(result.cancelReason === undefined ? {} : { cancelReason: result.cancelReason }),
  };
}
