// Interactive questionnaire component.
//
// Binds the pure state machine to Pi's TUI: key handling, the embedded editor
// used for free-text answers, themed rendering, and width-keyed line caching.
// All answer semantics live in `state.ts`; this module only translates input
// and paints the current snapshot.

import {
  CURSOR_MARKER,
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { answerLabels } from "./questions.ts";
import {
  answerPrefix,
  helpText,
  missingAnswerLabels,
  optionRowText,
  wrapLinesWithPrefix,
} from "./render.ts";
import { QuestionnaireState } from "./state.ts";
import type { Question, QuestionnaireResult } from "./types.ts";

/** Minimal theme surface this component needs, kept structural for testing. */
type ThemeLike = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
};

/** Handle returned to the tool so an aborted call can cancel the prompt. */
export interface QuestionnaireComponent extends Component, Focusable {
  /** Always present, unlike the optional base `Component.handleInput`. */
  handleInput(data: string): void;
  invalidate(): void;
  cancel(): void;
}

export interface CreateQuestionnaireComponentOptions {
  questions: Question[];
  tui: ConstructorParameters<typeof Editor>[0];
  theme: unknown;
  done: (result: QuestionnaireResult) => void;
}

/**
 * Create the questionnaire component.
 *
 * `theme` is Pi's interactive theme; it is narrowed structurally so tests can
 * pass a plain formatter object without constructing a full theme.
 */
export function createQuestionnaireComponent(
  options: CreateQuestionnaireComponentOptions,
): QuestionnaireComponent {
  const { questions, tui, done } = options;
  const theme = options.theme as ThemeLike;
  const state = new QuestionnaireState({ questions, onSettled: done });

  let focused = false;
  let cachedLines: string[] | undefined;
  let cachedWidth: number | undefined;
  let cachedRevision: number | undefined;

  const editorTheme: EditorTheme = {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
  const editor = new Editor(tui, editorTheme);

  function invalidateCache(): void {
    cachedLines = undefined;
    cachedWidth = undefined;
    cachedRevision = undefined;
  }

  function refresh(): void {
    invalidateCache();
    tui.requestRender();
  }

  function beginCustomInput(question: Question): void {
    state.startCustomInput(question);
    editor.setText("");
    editor.focused = focused;
    refresh();
  }

  editor.onSubmit = (value) => {
    if (!state.isEditing) return;
    if (state.submitCustomInput(value)) editor.setText("");
    refresh();
  };

  function handleEditingInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      state.cancelCustomInput();
      editor.setText("");
      refresh();
      return;
    }
    editor.handleInput(data);
    if (!matchesKey(data, Key.enter)) state.clearCustomError();
    refresh();
  }

  function handleInput(data: string): void {
    if (state.isEditing) {
      handleEditingInput(data);
      return;
    }

    const question = state.currentQuestion();
    const options = state.currentOptions();

    if (state.hasMultipleQuestions) {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
        state.moveTab(1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
        state.moveTab(-1);
        refresh();
        return;
      }
    }

    if (state.onReviewTab) {
      if (matchesKey(data, Key.enter) && state.allAnswered()) state.submit(false);
      else if (matchesKey(data, Key.escape)) state.submit(true);
      return;
    }

    if (matchesKey(data, Key.up)) {
      state.moveCursor(-1);
      refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      state.moveCursor(1);
      refresh();
      return;
    }

    if (question?.multiSelect && matchesKey(data, Key.space)) {
      const option = options[state.optionIndex];
      if (option && !option.isOther) {
        state.toggleMultiSelection(question, state.optionIndex);
        refresh();
      }
      return;
    }

    if (matchesKey(data, Key.enter) && question) {
      const option = options[state.optionIndex];
      if (option?.isOther) {
        beginCustomInput(question);
        return;
      }
      if (question.multiSelect) {
        state.confirmMultiAnswer(question);
        refresh();
        return;
      }
      if (option) {
        state.saveSingleAnswer(question, option, state.optionIndex);
        refresh();
      }
      return;
    }

    if (matchesKey(data, Key.escape)) state.submit(true);
  }

  function renderTabs(lines: string[], width: number): void {
    const tabs: string[] = ["← "];
    for (let index = 0; index < questions.length; index++) {
      const question = questions[index]!;
      const active = index === state.currentTab;
      const answered = state.hasAnswer(question.id);
      const text = ` ${answered ? "■" : "□"} ${question.label} `;
      const styled = active
        ? theme.bg("selectedBg", theme.fg("text", text))
        : theme.fg(answered ? "success" : "muted", text);
      tabs.push(`${styled} `);
    }
    const submitText = " ✓ Submit ";
    const submitStyled = state.onReviewTab
      ? theme.bg("selectedBg", theme.fg("text", submitText))
      : theme.fg(state.allAnswered() ? "success" : "dim", submitText);
    tabs.push(`${submitStyled} →`);
    lines.push(...wrapLinesWithPrefix(" ", tabs.join(""), width));
    lines.push("");
  }

  function renderOptions(lines: string[], width: number, question: Question | undefined): void {
    const options = state.currentOptions();
    const selections = question ? state.selectionsFor(question.id) : new Set<number>();
    for (let index = 0; index < options.length; index++) {
      const option = options[index]!;
      const selected = index === state.optionIndex;
      const checkbox =
        question?.multiSelect && !option.isOther ? (selections.has(index) ? "☑ " : "☐ ") : "";
      const prefix = selected ? theme.fg("accent", "> ") : "  ";
      const label = optionRowText(option, index, checkbox, state.isEditing);
      lines.push(...wrapLinesWithPrefix(prefix, theme.fg(selected ? "accent" : "text", label), width));
      if (option.description) {
        lines.push(...wrapLinesWithPrefix("     ", theme.fg("muted", option.description), width));
      }
    }
  }

  function renderEditing(lines: string[], width: number, question: Question): void {
    lines.push(...wrapLinesWithPrefix(" ", theme.fg("text", question.prompt), width));
    lines.push("");
    renderOptions(lines, width, question);
    lines.push("");
    lines.push(...wrapLinesWithPrefix(" ", theme.fg("muted", "Your answer:"), width));
    if (width <= 3) {
      const text = truncateToWidth(editor.getText(), width, "");
      lines.push(`${text}${focused ? CURSOR_MARKER : ""}`);
    } else {
      for (const line of editor.render(width - 1)) {
        lines.push(...wrapLinesWithPrefix(" ", line, width));
      }
    }
    lines.push("");
    if (state.customErrorFor(question.id)) {
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("warning", "Enter a response before continuing"), width));
    }
    lines.push(...wrapLinesWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"), width));
  }

  function renderReview(lines: string[], width: number): void {
    lines.push(...wrapLinesWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")), width));
    lines.push("");
    for (const question of questions) {
      const answer = state.answerFor(question.id);
      if (!answer) continue;
      const body = `${answerPrefix(answer)}${answerLabels(answer)}`;
      const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", body)}`;
      lines.push(...wrapLinesWithPrefix(" ", summary, width));
    }
    lines.push("");
    if (state.allAnswered()) {
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("success", "Press Enter to submit"), width));
    } else {
      const missing = missingAnswerLabels(questions, state.answerMap()).join(", ");
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`), width));
    }
  }

  function render(width: number): string[] {
    if (cachedLines && cachedWidth === width && cachedRevision === state.revision) return cachedLines;

    const renderWidth = Math.max(1, width);
    const lines: string[] = [];
    const question = state.currentQuestion();

    lines.push(theme.fg("accent", "─".repeat(renderWidth)));
    if (state.hasMultipleQuestions) renderTabs(lines, renderWidth);

    if (state.isEditing && question) {
      renderEditing(lines, renderWidth, question);
    } else if (state.onReviewTab) {
      renderReview(lines, renderWidth);
    } else if (question) {
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("text", question.prompt), renderWidth));
      lines.push("");
      renderOptions(lines, renderWidth, question);
      if (question.multiSelect && state.multiErrorFor(question.id)) {
        lines.push("");
        lines.push(
          ...wrapLinesWithPrefix(" ", theme.fg("warning", "Select at least one option before continuing"), renderWidth),
        );
      }
    }

    lines.push("");
    if (!state.isEditing) {
      const help = helpText(state.hasMultipleQuestions, question?.multiSelect === true);
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("dim", help), renderWidth));
    }
    lines.push(theme.fg("accent", "─".repeat(renderWidth)));

    cachedLines = lines;
    cachedWidth = width;
    cachedRevision = state.revision;
    return lines;
  }

  return {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      editor.focused = value;
      invalidateCache();
      editor.invalidate();
    },
    render,
    invalidate: () => {
      invalidateCache();
      editor.invalidate();
    },
    handleInput,
    cancel: () => state.submit(true),
  };
}
