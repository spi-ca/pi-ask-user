// Shared questionnaire value types.
//
// These describe the normalized question set the TUI renders and the answers
// the tool returns. Only plain data lives here so both the pure formatting
// helpers and the interactive component can depend on it without cycles.

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

/** A question option plus the synthetic entries appended by the renderer. */
export type RenderOption = QuestionOption & {
  /** The "type something" entry that opens the free-text editor. */
  isOther?: boolean;
  /** The "skip this question" entry shown for optional questions. */
  isSkip?: boolean;
  /** Position in the question's own option list, stable under filtering. */
  optionIndex?: number;
};

export interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
  /** Answering is not required; the option list gains a skip entry. */
  optional: boolean;
  /** Single-select: submit only from the review tab instead of immediately. */
  requireReview: boolean;
  /** Option values pre-selected when the question is first shown. */
  defaultValues: string[];
  /** Inclusive lower bound on multi-select choices. Always at least 1. */
  minSelections: number;
  /** Inclusive upper bound on multi-select choices, or undefined when unbounded. */
  maxSelections?: number;
  /** Label of the free-text entry in the option list. */
  otherLabel: string;
  /** Hint shown above the free-text editor. */
  otherPlaceholder?: string;
  /** Code-point cap applied to free-text answers. */
  otherMaxLength: number;
}

export interface SelectedOption {
  value: string;
  label: string;
  /** 1-based option position, as shown in the option list. */
  index: number;
}

export type Answer =
  | { id: string; kind: "single"; value: string; label: string; index: number }
  | { id: string; kind: "custom"; value: string; label: string }
  | {
      id: string;
      kind: "multi";
      selections: SelectedOption[];
      /** Free-text addition, present only when the user typed one. */
      custom?: string;
    }
  | { id: string; kind: "skipped" };

/** Why a questionnaire settled without complete answers. */
export type CancelReason = "user" | "aborted" | "unavailable" | "invalid";

export interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
  /** Present only when `cancelled` is true. */
  cancelReason?: CancelReason;
}
