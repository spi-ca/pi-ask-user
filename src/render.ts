// Pure layout and plain-text formatting helpers.
//
// Nothing here touches the TUI or theme, so the geometry rules (wrapping,
// hanging indents, option ordering, viewport windowing, summary text) are
// directly testable. The component supplies already-styled strings; ANSI-aware
// wrapping keeps escape sequences intact.

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { answerLabels } from "./questions.ts";
import type { Answer, Question, RenderOption } from "./types.ts";

export const OTHER_OPTION_VALUE = "__other__";
export const SKIP_OPTION_VALUE = "__skip__";
export const OTHER_OPTION_LABEL = "Type something.";
export const SKIP_OPTION_LABEL = "Skip this question.";

/** Largest option window, before terminal height narrows it further. */
export const MAX_VISIBLE_OPTIONS = 10;
/** Smallest option window; below this, scrolling is worse than a long list. */
export const MIN_VISIBLE_OPTIONS = 3;
/** Rows the frame, prompt, help, and tab bar need outside the option window. */
export const RESERVED_ROWS = 12;

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

/**
 * Question options plus the synthetic skip and custom-input entries.
 *
 * Real options carry `optionIndex`, their position in `question.options`, so
 * answers stay correct while the visible list is filtered.
 */
export function buildRenderOptions(question: Question | undefined): RenderOption[] {
  if (!question) return [];
  const options: RenderOption[] = question.options.map((option, optionIndex) => ({ ...option, optionIndex }));
  if (question.allowOther) {
    options.push({ value: OTHER_OPTION_VALUE, label: question.otherLabel, isOther: true });
  }
  if (question.optional) {
    options.push({ value: SKIP_OPTION_VALUE, label: SKIP_OPTION_LABEL, isSkip: true });
  }
  return options;
}

/**
 * Narrow a render list by a case-insensitive substring of label or value.
 * Synthetic entries always survive so skipping and free text stay reachable.
 */
export function filterRenderOptions(options: RenderOption[], filter: string): RenderOption[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) => {
    if (option.isOther || option.isSkip) return true;
    return (
      option.label.toLowerCase().includes(needle) ||
      option.value.toLowerCase().includes(needle) ||
      (option.description?.toLowerCase().includes(needle) ?? false)
    );
  });
}

/** True when at least one real option is present in a filtered list. */
export function hasRealOptions(options: RenderOption[]): boolean {
  return options.some((option) => !option.isOther && !option.isSkip);
}

/** Option window size for a terminal height, clamped to sane bounds. */
export function visibleOptionCount(terminalRows: number | undefined): number {
  if (typeof terminalRows !== "number" || !Number.isFinite(terminalRows)) return MAX_VISIBLE_OPTIONS;
  const available = Math.floor(terminalRows) - RESERVED_ROWS;
  return Math.max(MIN_VISIBLE_OPTIONS, Math.min(MAX_VISIBLE_OPTIONS, available));
}

/**
 * Scroll offset that keeps `cursor` visible while moving as little as possible.
 * Returns 0 whenever the whole list fits in the window.
 */
export function clampViewportOffset(total: number, cursor: number, maxVisible: number, offset: number): number {
  if (maxVisible <= 0 || total <= maxVisible) return 0;
  const highest = total - maxVisible;
  let next = Math.min(Math.max(0, offset), highest);
  if (cursor < next) next = cursor;
  else if (cursor > next + maxVisible - 1) next = cursor - maxVisible + 1;
  return Math.min(Math.max(0, next), highest);
}

/** Hidden-row counts for the scroll indicators above and below the window. */
export function viewportOverflow(total: number, offset: number, maxVisible: number): { above: number; below: number } {
  if (maxVisible <= 0 || total <= maxVisible) return { above: 0, below: 0 };
  const start = Math.min(Math.max(0, offset), total - maxVisible);
  return { above: start, below: total - start - maxVisible };
}

/** `↑ 3 more` / `↓ 3 more` indicator text. */
export function overflowText(direction: "above" | "below", count: number): string {
  return `${direction === "above" ? "↑" : "↓"} ${count} more`;
}

/** `(wrote) ` marker for free-text answers, empty for chosen options. */
export function answerPrefix(answer: Answer): string {
  return answer.kind === "custom" ? "(wrote) " : "";
}

/** One review-line body, e.g. `Language: (wrote) Korean`. */
export function formatAnswerSummary(question: Question | undefined, answer: Answer): string {
  return `${question?.label || answer.id}: ${answerPrefix(answer)}${answerLabels(answer)}`;
}

/** Labels of required questions that still have no answer, in question order. */
export function missingAnswerLabels(questions: Question[], answers: ReadonlyMap<string, Answer>): string[] {
  return questions.filter((question) => !answers.has(question.id)).map((question) => question.label);
}

/** Inline error text for a multi-select bound that the current choice violates. */
export function selectionErrorText(question: Question, kind: "min" | "max"): string {
  if (kind === "max") {
    const maximum = question.maxSelections ?? question.options.length;
    return `Select at most ${maximum} option${maximum === 1 ? "" : "s"}`;
  }
  if (question.minSelections <= 1) return "Select at least one option before continuing";
  return `Select at least ${question.minSelections} options before continuing`;
}

/** Range hint shown under a bounded multi-select prompt. */
export function selectionBoundsText(question: Question): string | undefined {
  const { minSelections, maxSelections } = question;
  if (minSelections <= 1 && maxSelections === undefined) return undefined;
  if (maxSelections === undefined) return `Choose at least ${minSelections}`;
  if (maxSelections === minSelections) return `Choose exactly ${minSelections}`;
  return `Choose ${minSelections}–${maxSelections}`;
}

/** Progress text for a bounded multi-select question, e.g. `2/3 selected`. */
export function selectionCountText(selected: number, question: Question): string {
  const bounds = selectionBoundsText(question);
  return bounds ? `${selected} selected • ${bounds}` : `${selected} selected`;
}

export interface HelpKeyLabels {
  up: string;
  down: string;
  confirm: string;
  cancel: string;
}

export const DEFAULT_HELP_KEYS: HelpKeyLabels = {
  up: "↑",
  down: "↓",
  confirm: "Enter",
  cancel: "Esc",
};

export interface HelpTextOptions {
  hasMultipleQuestions: boolean;
  multiSelect: boolean;
  /** The option list is long enough that filtering helps. */
  canFilter?: boolean;
  /** A filter is being typed, so most keys go to the filter. */
  filterActive?: boolean;
  keys?: Partial<HelpKeyLabels>;
}

/** Footer hint text, built from the keys actually bound in this session. */
export function helpText(options: HelpTextOptions): string {
  const keys = { ...DEFAULT_HELP_KEYS, ...options.keys };
  if (options.filterActive) {
    return `Type to filter • ${keys.up}${keys.down} select • ${keys.confirm} choose • ${keys.cancel} clear filter`;
  }

  const segments: string[] = [];
  segments.push(
    options.hasMultipleQuestions
      ? `Tab/←→ navigate • ${keys.up}${keys.down} select`
      : `${keys.up}${keys.down} navigate`,
  );
  segments.push("1-9 jump");
  segments.push(
    options.multiSelect ? `Space toggle • a all • c clear • ${keys.confirm} confirm` : `${keys.confirm} select`,
  );
  if (options.canFilter) segments.push("/ filter");
  segments.push(`${keys.cancel} cancel`);
  return segments.join(" • ");
}

/** Option row body without styling, e.g. `☑ 2. Korean`. */
export function optionRowText(option: RenderOption, index: number, checkbox: string, editing: boolean): string {
  return `${checkbox}${index + 1}. ${option.label}${option.isOther && editing ? " ✎" : ""}`;
}
