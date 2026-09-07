// Interactive questionnaire component.
//
// Binds the pure state machine to Pi's TUI: key handling, the embedded editor
// used for free-text answers, themed rendering, and width-keyed line caching.
// All answer semantics live in `state.ts`; this module only translates input
// and paints the current snapshot.

import {
  type Component,
  CURSOR_MARKER,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  sliceByColumn,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createKeyResolver, type KeyResolver } from "./keys.ts";
import { answerLabels } from "./questions.ts";
import {
  answerPrefix,
  clampViewportOffset,
  helpText,
  missingAnswerLabels,
  optionRowText,
  overflowText,
  selectionCountText,
  selectionErrorText,
  visibleOptionCount,
  wrapLinesWithPrefix,
} from "./render.ts";
import { MAX_DISPLAY_LENGTH, stripUnsafeCharacters, truncateCodePoints } from "./sanitize.ts";
import { QuestionnaireState } from "./state.ts";
import type { CancelReason, Question, QuestionnaireResult, RenderOption } from "./types.ts";

/** Option count above which the filter hint is worth showing. */
const FILTER_HINT_THRESHOLD = 8;

/** Minimal theme surface this component needs, kept structural for testing. */
type ThemeLike = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
};

type HitRegion =
  | { kind: "option"; optionIndex: number; xStart: number; xEnd: number; y: number }
  | { kind: "tab"; tabIndex: number; xStart: number; xEnd: number; y: number };

type EditorRegion = { x: number; y: number; width: number; height: number };

/** Full-width vertical extent of a rendered, non-empty option block. */
type OptionBlockRegion = { yStart: number; yEnd: number };

type PendingPressTarget =
  | { kind: "option"; optionIndex: number }
  | { kind: "tab"; tabIndex: number }
  | { kind: "editor" }
  | { kind: "miss" };

type PendingPress = {
  target: PendingPressTarget;
  revision: number;
  width: number;
  terminalColumns: number | undefined;
  terminalRows: number | undefined;
  valid: boolean;
};

/** Handle returned to the tool so an aborted call can cancel the prompt. */
export interface QuestionnaireComponent extends Component, Focusable {
  /** Always present, unlike the optional base `Component.handleInput`. */
  handleInput(data: string): void;
  /** Always present so fullscreen Pi can dispatch pointer input. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  invalidate(): void;
  cancel(reason?: CancelReason): void;
}

export interface CreateQuestionnaireComponentOptions {
  questions: Question[];
  tui: ConstructorParameters<typeof Editor>[0];
  theme: unknown;
  /** Pi's `KeybindingsManager`; defaults are used when absent. */
  keybindings?: unknown;
  done: (result: QuestionnaireResult) => void;
}

/**
 * True for a single printable character that should start or extend a filter.
 * Space is excluded so it keeps toggling multi-select options while filtering.
 */
function isFilterCharacter(data: string): boolean {
  if ([...data].length !== 1) return false;
  const codePoint = data.codePointAt(0) ?? 0;
  return codePoint > 0x20 && codePoint !== 0x7f;
}

/**
 * Harden the live editor buffer without otherwise reshaping it.
 *
 * Unlike the submit path this must not trim, because trimming while the user is
 * still typing would eat the space between words.
 */
function sanitizeEditorText(text: string, limit: number): string {
  return truncateCodePoints(stripUnsafeCharacters(text, false, limit + 1), limit);
}

/**
 * Create the questionnaire component.
 *
 * `theme` is Pi's interactive theme; it is narrowed structurally so tests can
 * pass a plain formatter object without constructing a full theme.
 */
export function createQuestionnaireComponent(options: CreateQuestionnaireComponentOptions): QuestionnaireComponent {
  const { questions, tui, done } = options;
  const theme = options.theme as ThemeLike;
  const keys: KeyResolver = createKeyResolver(options.keybindings);
  // An explicitly empty submit binding may use Enter for another editor action
  // (notably a newline). Do not open a free-text editor without a working
  // submit key; preserve the normalized questions in the returned details.
  const interactiveQuestions = keys.canSubmit()
    ? questions
    : questions.map((question) => ({ ...question, allowOther: false }));
  const state = new QuestionnaireState({
    questions: interactiveQuestions,
    onSettled: (result) => done({ ...result, questions }),
  });

  let focused = false;
  let cachedLines: string[] | undefined;
  let cachedWidth: number | undefined;
  let cachedRevision: number | undefined;
  let cachedTerminalRows: number | undefined;
  let cachedHitRegions: HitRegion[] = [];
  let cachedEditorRegion: EditorRegion | undefined;
  let cachedOptionBlockRegion: OptionBlockRegion | undefined;
  let pendingPress: PendingPress | undefined;
  /** First visible option row, recomputed on every render from the cursor. */
  let viewportOffset = 0;

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
    cachedTerminalRows = undefined;
    cachedHitRegions = [];
    cachedEditorRegion = undefined;
    cachedOptionBlockRegion = undefined;
  }

  function refresh(): void {
    invalidateCache();
    tui.requestRender();
  }

  function invalidatePendingPress(): void {
    if (pendingPress) pendingPress.valid = false;
  }

  function maxVisibleOptions(): number {
    return visibleOptionCount(tui.terminal?.rows);
  }

  function cancelEditingForPointer(): void {
    if (!state.isEditing) return;
    state.cancelCustomInput();
    editor.setText("");
  }

  function beginCustomInput(question: Question): void {
    state.startCustomInput(question);
    // A multi-select question keeps its typed text so the editor reopens with
    // the previous value instead of discarding it.
    editor.setText(question.multiSelect ? (state.customTextFor(question.id) ?? "") : "");
    editor.focused = focused;
    refresh();
  }

  editor.onSubmit = (value) => {
    if (!state.isEditing) return;
    if (state.submitCustomInput(value)) editor.setText("");
    refresh();
  };

  function handleEditingInput(data: string): void {
    const question = state.currentQuestion();
    if (matchesKey(data, Key.escape) || keys.matches(data, "cancel")) {
      state.cancelCustomInput();
      editor.setText("");
      refresh();
      return;
    }
    // The embedded Editor does not receive the custom component's keybinding
    // manager. Dispatch the resolved submit action ourselves, including the
    // Enter fallback used when tui.input.submit is explicitly unbound.
    if (keys.matches(data, "submit")) {
      editor.onSubmit?.(editor.getText());
      return;
    }
    // Do not let Editor's built-in Enter handler contradict a configured
    // non-Enter submit binding that the surrounding component advertises.
    if (matchesKey(data, Key.enter)) return;

    const before = editor.getText();
    editor.handleInput(data);
    const after = editor.getText();
    if (after !== before) {
      // pi-tui's paste filter only drops code units below U+0020, so C1 and
      // bidi characters would otherwise reach the screen from the live buffer.
      // Rewriting is limited to inputs that actually carry something unsafe or
      // overlong, since setText also resets the cursor and pushes undo state.
      const safe = sanitizeEditorText(after, question?.otherMaxLength ?? MAX_DISPLAY_LENGTH);
      if (safe !== after) editor.setText(safe);
      // Editing away from a rejected value clears the error; a submit attempt
      // that changed nothing leaves it on screen.
      state.clearCustomError();
    }
    refresh();
  }

  /** Filter mode swallows printable keys; navigation and confirm still work. */
  function handleFilteringInput(data: string): boolean {
    if (keys.matches(data, "cancel")) {
      state.clearFilter();
      refresh();
      return true;
    }
    if (matchesKey(data, Key.backspace)) {
      state.backspaceFilter();
      refresh();
      return true;
    }
    if (isFilterCharacter(data)) {
      state.appendFilter(data);
      refresh();
      return true;
    }
    return false;
  }

  /** Act on the row under the cursor: skip, free text, toggle, or select. */
  function activateOption(question: Question, option: RenderOption | undefined): void {
    if (!option) return;
    if (option.isSkip) {
      state.skipQuestion(question);
      refresh();
      return;
    }
    if (option.isOther) {
      beginCustomInput(question);
      return;
    }
    if (question.multiSelect) {
      state.confirmMultiAnswer(question);
      refresh();
      return;
    }
    if (option.optionIndex !== undefined) {
      state.saveSingleAnswer(question, option.optionIndex);
      refresh();
    }
  }

  /** `1`–`9` jump to that visible row and act on it, like Pi's own lists. */
  function handleDigit(data: string, question: Question, options: RenderOption[]): boolean {
    if (data.length !== 1 || data < "1" || data > "9") return false;
    const row = Number(data) - 1;
    if (row >= options.length) return true;
    if (!state.moveCursorTo(row)) return true;
    const option = options[row];
    if (question.multiSelect && option && !option.isOther && !option.isSkip && option.optionIndex !== undefined) {
      state.toggleMultiSelection(question, option.optionIndex);
      refresh();
      return true;
    }
    activateOption(question, option);
    return true;
  }

  function handleMultiSelectKeys(data: string, question: Question, options: RenderOption[]): boolean {
    if (matchesKey(data, Key.space)) {
      const option = options[state.optionIndex];
      if (option && !option.isOther && !option.isSkip && option.optionIndex !== undefined) {
        state.toggleMultiSelection(question, option.optionIndex);
        refresh();
      }
      return true;
    }
    if (data === "a" || data === "A") {
      state.selectAll(question);
      refresh();
      return true;
    }
    if (data === "c" || data === "C") {
      state.clearSelections(question);
      refresh();
      return true;
    }
    return false;
  }

  function handleReviewInput(data: string): void {
    if (keys.matches(data, "confirm")) {
      if (state.allAnswered()) {
        state.submit(false);
        return;
      }
      // Enter with gaps left is a navigation request, not a failed submit.
      const target = state.firstUnansweredTab();
      if (target !== undefined) {
        state.moveToTab(target);
        refresh();
      }
      return;
    }
    if (keys.matches(data, "cancel")) state.submit(true, "user");
  }

  function handleInput(data: string): void {
    // Keyboard input interrupts a pointer gesture even when it leaves the
    // questionnaire state unchanged (for example, an editor cursor move).
    invalidatePendingPress();
    const revisionBefore = state.revision;
    try {
      // Escape always settles the questionnaire from a plain question view,
      // whatever the configured bindings are. Without this, a manager that claims
      // every key could leave the prompt with no way out.
      if (!state.isEditing && !state.isFiltering && matchesKey(data, Key.escape)) {
        state.submit(true, "user");
        return;
      }

      if (state.isEditing) {
        handleEditingInput(data);
        return;
      }

      if (state.totalTabs > 1) {
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
        handleReviewInput(data);
        return;
      }

      const question = state.currentQuestion();
      const options = state.currentOptions();

      if (keys.matches(data, "up")) {
        if (state.moveCursor(-1)) refresh();
        return;
      }
      if (keys.matches(data, "down")) {
        if (state.moveCursor(1)) refresh();
        return;
      }

      if (question && keys.matches(data, "confirm")) {
        activateOption(question, options[state.optionIndex]);
        return;
      }

      // Space keeps toggling while a filter is being typed, so it is handled
      // before filter input claims printable keys.
      if (question?.multiSelect && matchesKey(data, Key.space)) {
        handleMultiSelectKeys(data, question, options);
        return;
      }

      if (question && state.isFiltering) {
        if (handleFilteringInput(data)) return;
      } else if (question) {
        if (question.multiSelect && handleMultiSelectKeys(data, question, options)) return;
        if (handleDigit(data, question, options)) return;
        if (data === "/") {
          state.startFiltering();
          refresh();
          return;
        }
      }

      if (keys.matches(data, "cancel")) state.submit(true, "user");
    } finally {
      if (state.revision !== revisionBefore) invalidatePendingPress();
    }
  }

  function renderTabs(lines: string[], width: number, hitRegions: HitRegion[]): void {
    const segments: Array<{ text: string; styled: string; tabIndex?: number }> = [{ text: "← ", styled: "← " }];
    for (let index = 0; index < questions.length; index++) {
      const question = questions[index]!;
      const active = index === state.currentTab;
      const answered = state.hasAnswer(question.id);
      const text = ` ${answered ? "■" : "□"} ${question.label} `;
      const styled = active
        ? theme.bg("selectedBg", theme.fg("text", text))
        : theme.fg(answered ? "success" : "muted", text);
      segments.push({ text, styled, tabIndex: index });
      segments.push({ text: " ", styled: " " });
    }
    const submitText = " ✓ Submit ";
    const submitStyled = state.onReviewTab
      ? theme.bg("selectedBg", theme.fg("text", submitText))
      : theme.fg(state.allAnswered() ? "success" : "dim", submitText);
    segments.push({ text: submitText, styled: submitStyled, tabIndex: questions.length });
    segments.push({ text: " →", styled: " →" });

    // Keep the tab geometry in the same cell layout used to render it. This
    // avoids deriving coordinates from JavaScript string offsets, which break
    // for ANSI and wide CJK graphemes.
    const renderWidth = Math.max(1, width);
    if (renderWidth === 1) {
      lines.push(...wrapLinesWithPrefix(" ", segments.map((segment) => segment.styled).join(""), renderWidth));
      lines.push("");
      return;
    }
    let line = " ";
    let lineWidth = 1;
    const finishLine = () => {
      lines.push(truncateToWidth(line, renderWidth, ""));
      line = " ";
      lineWidth = 1;
    };
    const continueWithoutPrefix = () => {
      line = "";
      lineWidth = 0;
    };
    for (const segment of segments) {
      const segmentWidth = visibleWidth(segment.text);
      let consumed = 0;
      while (consumed < segmentWidth) {
        const available = renderWidth - lineWidth;
        if (available <= 0) {
          finishLine();
          continue;
        }
        const piece = sliceByColumn(segment.styled, consumed, available, true);
        const pieceWidth = visibleWidth(piece);
        // A double-width grapheme cannot fit beside the prefix at width two.
        // A fresh prefixed line has the same constraint, so continue without
        // the prefix rather than repeatedly finishing an empty prefixed line.
        if (pieceWidth === 0) {
          if (lineWidth === 1 && line === " ") continueWithoutPrefix();
          else finishLine();
          continue;
        }
        const xStart = lineWidth;
        line += piece;
        lineWidth += pieceWidth;
        if (segment.tabIndex !== undefined) {
          hitRegions.push({
            kind: "tab",
            tabIndex: segment.tabIndex,
            xStart,
            xEnd: lineWidth,
            y: lines.length,
          });
        }
        consumed += pieceWidth;
        if (lineWidth >= renderWidth) finishLine();
      }
    }
    if (lineWidth > 1) lines.push(truncateToWidth(line, renderWidth, ""));
    lines.push("");
  }

  /**
   * Draw the option window around the cursor, with hidden-row indicators.
   * Display numbers follow the visible row so `1`–`9` always match the screen.
   */
  function renderOptions(
    lines: string[],
    width: number,
    question: Question | undefined,
    hitRegions: HitRegion[],
    setOptionBlockRegion: (region: OptionBlockRegion) => void,
  ): void {
    const options = state.currentOptions();
    if (options.length === 0) {
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("warning", "No options match the filter"), width));
      return;
    }

    const yStart = lines.length;
    const maxVisible = maxVisibleOptions();
    viewportOffset = clampViewportOffset(options.length, state.optionIndex, maxVisible, viewportOffset);
    const start = options.length > maxVisible ? viewportOffset : 0;
    const end = Math.min(options.length, start + (options.length > maxVisible ? maxVisible : options.length));
    const selections = question ? state.selectionsFor(question.id) : new Set<number>();

    if (start > 0) {
      lines.push(...wrapLinesWithPrefix("  ", theme.fg("dim", overflowText("above", start)), width));
    }
    for (let index = start; index < end; index++) {
      const option = options[index]!;
      const selected = index === state.optionIndex;
      const checked = option.optionIndex !== undefined && selections.has(option.optionIndex) ? "☑ " : "☐ ";
      const checkbox = question?.multiSelect && option.optionIndex !== undefined ? checked : "";
      const prefix = selected ? theme.fg("accent", "> ") : "  ";
      const label = optionRowText(option, index, checkbox, state.isEditing);
      const appendOptionLines = (prefixText: string, text: string) => {
        const optionLines = wrapLinesWithPrefix(prefixText, text, width);
        const prefixWidth = visibleWidth(prefixText);
        for (const optionLine of optionLines) {
          const lineWidth = visibleWidth(optionLine);
          // When the prefix fills the width, wrapLinesWithPrefix falls back to
          // unindented text wrapping. Its visible description lines therefore
          // begin at column zero and must remain clickable.
          const xStart = prefixWidth >= width ? 0 : Math.min(prefixWidth, lineWidth);
          if (xStart < lineWidth) {
            hitRegions.push({ kind: "option", optionIndex: index, xStart, xEnd: lineWidth, y: lines.length });
          }
          lines.push(optionLine);
        }
      };
      appendOptionLines(prefix, theme.fg(selected ? "accent" : "text", label));
      if (option.description) appendOptionLines("     ", theme.fg("muted", option.description));
    }
    if (end < options.length) {
      lines.push(...wrapLinesWithPrefix("  ", theme.fg("dim", overflowText("below", options.length - end)), width));
    }
    setOptionBlockRegion({ yStart, yEnd: lines.length });
  }

  function renderFilterLine(lines: string[], width: number, question: Question): void {
    const filter = state.filterFor(question.id);
    if (!filter && !state.isFiltering) return;
    const suffix = state.isFiltering && focused ? CURSOR_MARKER : "";
    lines.push(
      ...wrapLinesWithPrefix(" ", `${theme.fg("muted", "Filter: ")}${theme.fg("text", filter)}${suffix}`, width),
    );
  }

  function renderEditing(
    lines: string[],
    width: number,
    question: Question,
    hitRegions: HitRegion[],
    setEditorRegion: (region: EditorRegion | undefined) => void,
    setOptionBlockRegion: (region: OptionBlockRegion) => void,
  ): void {
    lines.push(...wrapLinesWithPrefix(" ", theme.fg("text", question.prompt), width));
    lines.push("");
    renderOptions(lines, width, question, hitRegions, setOptionBlockRegion);
    lines.push("");
    const hint = question.otherPlaceholder ? `Your answer: ${question.otherPlaceholder}` : "Your answer:";
    lines.push(...wrapLinesWithPrefix(" ", theme.fg("muted", hint), width));
    if (width <= 3) {
      setEditorRegion(undefined);
      const text = truncateToWidth(editor.getText(), width, "");
      lines.push(`${text}${focused ? CURSOR_MARKER : ""}`);
    } else {
      const editorLines = editor.render(width - 1);
      const editorStart = lines.length;
      setEditorRegion({ x: 1, y: editorStart, width: width - 1, height: editorLines.length });
      for (const line of editorLines) lines.push(...wrapLinesWithPrefix(" ", line, width));
    }
    lines.push("");
    if (state.customErrorFor(question.id)) {
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("warning", "Enter a response before continuing"), width));
    }
    lines.push(
      ...wrapLinesWithPrefix(
        " ",
        // The editor submits on Pi's input binding, not on the select-list
        // confirm binding, so the hint has to name that key.
        theme.fg("dim", `${keys.label("submit")} to submit • ${keys.label("cancel")} to cancel`),
        width,
      ),
    );
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
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("success", `Press ${keys.label("confirm")} to submit`), width));
    } else {
      const missing = missingAnswerLabels(questions, state.answerMap()).join(", ");
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`), width));
      lines.push(
        ...wrapLinesWithPrefix(
          " ",
          theme.fg("dim", `${keys.label("confirm")} jumps to the first unanswered question`),
          width,
        ),
      );
    }
  }

  function renderQuestion(
    lines: string[],
    width: number,
    question: Question,
    hitRegions: HitRegion[],
    setOptionBlockRegion: (region: OptionBlockRegion) => void,
  ): void {
    lines.push(...wrapLinesWithPrefix(" ", theme.fg("text", question.prompt), width));
    lines.push("");
    renderFilterLine(lines, width, question);
    renderOptions(lines, width, question, hitRegions, setOptionBlockRegion);

    if (question.multiSelect) {
      const selected = state.selectionsFor(question.id).size + (state.customTextFor(question.id) ? 1 : 0);
      lines.push("");
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("muted", selectionCountText(selected, question)), width));
      const custom = state.customTextFor(question.id);
      if (custom) {
        lines.push(...wrapLinesWithPrefix(" ", theme.fg("muted", `(wrote) ${custom}`), width));
      }
    }

    const errorKind = state.selectionErrorFor(question.id);
    if (errorKind) {
      lines.push("");
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("warning", selectionErrorText(question, errorKind)), width));
    }
  }

  function render(width: number): string[] {
    const terminalRows = tui.terminal?.rows;
    if (
      cachedLines &&
      cachedWidth === width &&
      cachedRevision === state.revision &&
      cachedTerminalRows === terminalRows
    ) {
      return cachedLines;
    }

    const renderWidth = Math.max(1, width);
    const lines: string[] = [];
    const hitRegions: HitRegion[] = [];
    let editorRegion: EditorRegion | undefined;
    let optionBlockRegion: OptionBlockRegion | undefined;
    const question = state.currentQuestion();

    lines.push(theme.fg("accent", "─".repeat(renderWidth)));
    if (state.totalTabs > 1) renderTabs(lines, renderWidth, hitRegions);

    if (state.isEditing && question) {
      renderEditing(
        lines,
        renderWidth,
        question,
        hitRegions,
        (region) => {
          editorRegion = region;
        },
        (region) => {
          optionBlockRegion = region;
        },
      );
    } else if (state.onReviewTab) {
      renderReview(lines, renderWidth);
    } else if (question) {
      renderQuestion(lines, renderWidth, question, hitRegions, (region) => {
        optionBlockRegion = region;
      });
    }

    lines.push("");
    if (!state.isEditing) {
      const help = helpText({
        hasMultipleQuestions: state.totalTabs > 1,
        multiSelect: question?.multiSelect === true,
        canFilter: (question?.options.length ?? 0) >= FILTER_HINT_THRESHOLD,
        filterActive: state.isFiltering,
        keys: {
          up: keys.label("up"),
          down: keys.label("down"),
          confirm: keys.label("confirm"),
          cancel: keys.label("cancel"),
        },
      });
      lines.push(...wrapLinesWithPrefix(" ", theme.fg("dim", help), renderWidth));
    }
    lines.push(theme.fg("accent", "─".repeat(renderWidth)));

    cachedLines = lines;
    cachedWidth = width;
    cachedRevision = state.revision;
    cachedTerminalRows = terminalRows;
    cachedHitRegions = hitRegions;
    cachedEditorRegion = editorRegion;
    cachedOptionBlockRegion = optionBlockRegion;
    return lines;
  }

  function hitRegionAt(event: TuiMouseEvent): HitRegion | undefined {
    // Rendering and hit testing share one cached generation. Calling render here
    // also rebuilds geometry after a host resize that arrives before its paint.
    render(Math.max(1, event.width));
    return cachedHitRegions.find((region) => region.y === event.y && event.x >= region.xStart && event.x < region.xEnd);
  }

  function optionBlockContains(event: TuiMouseEvent): boolean {
    const block = cachedOptionBlockRegion;
    const width = Math.max(1, event.width);
    return block !== undefined && event.x >= 0 && event.x < width && event.y >= block.yStart && event.y < block.yEnd;
  }

  function targetForRegion(region: HitRegion | undefined): PendingPressTarget {
    if (!region) return { kind: "miss" };
    if (region.kind === "option") return { kind: "option", optionIndex: region.optionIndex };
    return { kind: "tab", tabIndex: region.tabIndex };
  }

  function sameTarget(left: PendingPressTarget, right: PendingPressTarget): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "option" && right.kind === "option") return left.optionIndex === right.optionIndex;
    if (left.kind === "tab" && right.kind === "tab") return left.tabIndex === right.tabIndex;
    return true;
  }

  function rememberPress(target: PendingPressTarget, width: number): void {
    pendingPress = {
      target,
      revision: state.revision,
      width,
      terminalColumns: tui.terminal?.columns,
      terminalRows: tui.terminal?.rows,
      valid: true,
    };
  }

  function consumeInvalidPendingClick(target: PendingPressTarget, event: TuiMouseEvent): boolean {
    if (!pendingPress) return false;
    const press = pendingPress;
    pendingPress = undefined;
    const valid =
      press.valid &&
      press.revision === state.revision &&
      press.width === event.width &&
      press.terminalColumns === tui.terminal?.columns &&
      press.terminalRows === tui.terminal?.rows &&
      sameTarget(press.target, target);
    return !valid;
  }

  function handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Every new press supersedes the previous gesture, including presses that
    // miss this component or land on an editor child.
    if (event.type === "press") pendingPress = undefined;
    render(Math.max(1, event.width));
    const region = hitRegionAt(event);

    if (event.type === "drag") {
      invalidatePendingPress();
      return undefined;
    }

    const editorRegion = cachedEditorRegion;
    if (
      editorRegion &&
      event.x >= editorRegion.x &&
      event.x < editorRegion.x + editorRegion.width &&
      event.y >= editorRegion.y &&
      event.y < editorRegion.y + editorRegion.height
    ) {
      const target: PendingPressTarget = { kind: "editor" };
      if (event.button === "left" && event.type === "click" && consumeInvalidPendingClick(target, event)) {
        return { handled: true, focus: true, render: false };
      }
      const childResult = editor.handleMouse({
        ...event,
        x: event.x - editorRegion.x,
        y: event.y - editorRegion.y,
        width: editorRegion.width,
        height: editorRegion.height,
      });
      if (event.button === "left" && event.type === "press") rememberPress(target, event.width);
      if (childResult?.handled || childResult?.capture || childResult?.focus) {
        // Editor cursor movement changes its own render state without changing
        // QuestionnaireState.revision, so discard the parent generation too.
        invalidateCache();
        tui.requestRender();
        return { ...childResult, handled: true, focus: true };
      }
      return undefined;
    }

    if (event.type === "wheel") {
      invalidatePendingPress();
      if (!optionBlockContains(event) || !event.wheelDelta) return undefined;
      const moved = state.moveCursor(event.wheelDelta < 0 ? -1 : 1);
      if (moved) invalidateCache();
      // Consume at the bounds as well: fullscreen mouse wheel must not escape
      // to the transcript viewport behind this prompt.
      return { handled: true, render: moved };
    }

    if (event.button !== "left") return undefined;
    if (event.type === "press") {
      const target = targetForRegion(region);
      if (region?.kind === "option") {
        const moved = state.optionIndex !== region.optionIndex;
        state.moveCursorTo(region.optionIndex);
        if (moved) invalidateCache();
        // State cursor changes can increment the revision, so fence using the
        // post-move generation.
        rememberPress(target, event.width);
        return { handled: true, focus: true, render: moved };
      }
      if (region?.kind === "tab") {
        rememberPress(target, event.width);
        return { handled: true, focus: true, render: false };
      }
      rememberPress(target, event.width);
      return undefined;
    }
    if (event.type !== "click") return undefined;
    if (consumeInvalidPendingClick(targetForRegion(region), event))
      return { handled: true, focus: true, render: false };
    if (!region) return undefined;

    if (region.kind === "tab") {
      cancelEditingForPointer();
      state.moveToTab(region.tabIndex);
      refresh();
      return { handled: true, focus: true };
    }

    const question = state.currentQuestion();
    const option = state.currentOptions()[region.optionIndex];
    if (!question || !option) return undefined;
    cancelEditingForPointer();
    state.moveCursorTo(region.optionIndex);
    if (question.multiSelect && option.optionIndex !== undefined) {
      state.toggleMultiSelection(question, option.optionIndex);
      refresh();
    } else {
      activateOption(question, option);
    }
    return { handled: true, focus: true };
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
    handleMouse,
    cancel: (reason: CancelReason = "aborted") => state.submit(true, reason),
  };
}
