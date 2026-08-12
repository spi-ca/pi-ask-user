// Pure layout and plain-text formatting helpers.
//
// Nothing here touches the TUI or theme, so the geometry rules (wrapping,
// hanging indents, option ordering, summary text) are directly testable. The
// component supplies already-styled strings; ANSI-aware wrapping keeps escape
// sequences intact.

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { answerLabels } from "./questions.ts";
import type { Answer, Question, RenderOption } from "./types.ts";

export const OTHER_OPTION_VALUE = "__other__";
export const OTHER_OPTION_LABEL = "Type something.";

/** Wrap styled text to `width`, hard-truncating any residual overflow. */
export function wrapLines(text: string, width: number): string[] {
  const renderWidth = Math.max(1, width);
  return wrapTextWithAnsi(text, renderWidth).map((line) => truncateToWidth(line, renderWidth, ""));
}

/**
 * Wrap styled text with a prefix on the first line and a matching indent on
 * continuation lines. Falls back to plain wrapping when the prefix alone is at
 * least as wide as the render width.
 */
export function wrapLinesWithPrefix(prefix: string, text: string, width: number): string[] {
  const renderWidth = Math.max(1, width);
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= renderWidth) return wrapLines(prefix + text, renderWidth);

  const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
  const continuationPrefix = " ".repeat(prefixWidth);
  return wrapped.map((line, index) =>
    truncateToWidth(`${index === 0 ? prefix : continuationPrefix}${line}`, renderWidth, ""),
  );
}

/** Question options plus the trailing custom-input entry when allowed. */
export function buildRenderOptions(question: Question | undefined): RenderOption[] {
  if (!question) return [];
  const options: RenderOption[] = [...question.options];
  if (question.allowOther) {
    options.push({ value: OTHER_OPTION_VALUE, label: OTHER_OPTION_LABEL, isOther: true });
  }
  return options;
}

/** `(wrote) ` marker for free-text answers, empty for chosen options. */
export function answerPrefix(answer: Answer): string {
  return answer.kind === "custom" ? "(wrote) " : "";
}

/** One review-line body, e.g. `Language: (wrote) Korean`. */
export function formatAnswerSummary(question: Question | undefined, answer: Answer): string {
  return `${question?.label || answer.id}: ${answerPrefix(answer)}${answerLabels(answer)}`;
}

/** Labels of questions that still have no answer, in question order. */
export function missingAnswerLabels(questions: Question[], answers: ReadonlyMap<string, Answer>): string[] {
  return questions.filter((question) => !answers.has(question.id)).map((question) => question.label);
}

/** Footer hint text; content depends on multi-question and multi-select mode. */
export function helpText(hasMultipleQuestions: boolean, multiSelect: boolean): string {
  const actions = multiSelect ? "Space toggle • Enter confirm" : "Enter select";
  return hasMultipleQuestions
    ? `Tab/←→ navigate • ↑↓ select • ${actions} • Esc cancel`
    : `↑↓ navigate • ${actions} • Esc cancel`;
}

/** Option row body without styling, e.g. `☑ 2. Korean`. */
export function optionRowText(option: RenderOption, index: number, checkbox: string, editing: boolean): string {
  return `${checkbox}${index + 1}. ${option.label}${option.isOther && editing ? " ✎" : ""}`;
}
