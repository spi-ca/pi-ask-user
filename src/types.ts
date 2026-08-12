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

/** A question option plus the synthetic "type something" entry. */
export type RenderOption = QuestionOption & { isOther?: boolean };

export interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
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
  | { id: string; kind: "multi"; selections: SelectedOption[] };

export interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}
