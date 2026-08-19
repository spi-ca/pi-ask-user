// Questionnaire state machine, independent of the TUI.
//
// Owns tab position, option cursor, option filtering, multi-select toggles,
// recorded answers, validation errors, and single-shot settlement. The
// interactive component maps keys onto these transitions and renders the
// resulting snapshot, which keeps navigation and answer semantics testable
// without a terminal.

import { buildRenderOptions, filterRenderOptions } from "./render.ts";
import { sanitizeUserInput, stripUnsafeCharacters } from "./sanitize.ts";
import type { Answer, CancelReason, Question, QuestionnaireResult, RenderOption } from "./types.ts";

export interface QuestionnaireStateOptions {
  questions: Question[];
  /** Called exactly once when the questionnaire settles. */
  onSettled: (result: QuestionnaireResult) => void;
}

/** Which bound a rejected multi-select action violated. */
export type SelectionErrorKind = "min" | "max";

/** Where the cursor should rest when a question regains focus. */
type CursorTarget = { kind: "option"; index: number } | { kind: "other" } | { kind: "skip" };

export class QuestionnaireState {
  /** Index of the focused question, or `questions.length` for the review tab. */
  currentTab = 0;
  /** Cursor position within the visible option list, including synthetic entries. */
  optionIndex = 0;
  /** Bumped on every mutation so the component can skip redundant renders. */
  revision = 0;

  private readonly questions: Question[];
  private readonly onSettled: (result: QuestionnaireResult) => void;
  private readonly answers = new Map<string, Answer>();
  /** Chosen option positions within `question.options`, by question id. */
  private readonly multiSelections = new Map<string, Set<number>>();
  /** Free-text addition for multi-select questions, by question id. */
  private readonly multiCustom = new Map<string, string>();
  /** Per-question option filter text, by question id. */
  private readonly filters = new Map<string, string>();
  private editingQuestionId: string | null = null;
  private filteringQuestionId: string | null = null;
  private selectionError: { id: string; kind: SelectionErrorKind } | null = null;
  private customError: string | null = null;
  private settled = false;

  constructor(options: QuestionnaireStateOptions) {
    this.questions = options.questions;
    this.onSettled = options.onSettled;
    this.applyDefaults();
    this.syncCursorToAnswer();
  }

  get hasMultipleQuestions(): boolean {
    return this.questions.length > 1;
  }

  /**
   * Whether a review tab exists. Multi-question runs always have one; a single
   * question gets one when it opts into review before submitting.
   */
  get hasReviewTab(): boolean {
    return this.hasMultipleQuestions || this.questions.some((question) => question.requireReview);
  }

  /** Question tabs plus the review tab when present. */
  get totalTabs(): number {
    return this.questions.length + (this.hasReviewTab ? 1 : 0);
  }

  get isSettled(): boolean {
    return this.settled;
  }

  get isEditing(): boolean {
    return this.editingQuestionId !== null;
  }

  get editingId(): string | null {
    return this.editingQuestionId;
  }

  get isFiltering(): boolean {
    return this.filteringQuestionId !== null;
  }

  get onReviewTab(): boolean {
    return this.hasReviewTab && this.currentTab === this.questions.length;
  }

  currentQuestion(): Question | undefined {
    return this.questions[this.currentTab];
  }

  /** Visible options for the current question, after filtering. */
  currentOptions(): RenderOption[] {
    const question = this.currentQuestion();
    if (!question) return [];
    return filterRenderOptions(buildRenderOptions(question), this.filterFor(question.id));
  }

  filterFor(questionId: string): string {
    return this.filters.get(questionId) ?? "";
  }

  answerFor(questionId: string): Answer | undefined {
    return this.answers.get(questionId);
  }

  hasAnswer(questionId: string): boolean {
    return this.answers.has(questionId);
  }

  answerMap(): ReadonlyMap<string, Answer> {
    return this.answers;
  }

  /** Chosen positions within `question.options`, not visible-row positions. */
  selectionsFor(questionId: string): ReadonlySet<number> {
    return this.multiSelections.get(questionId) ?? new Set<number>();
  }

  customTextFor(questionId: string): string | undefined {
    return this.multiCustom.get(questionId);
  }

  selectionErrorFor(questionId: string): SelectionErrorKind | undefined {
    return this.selectionError?.id === questionId ? this.selectionError.kind : undefined;
  }

  /** Kept for callers that only need to know whether an error is showing. */
  multiErrorFor(questionId: string): boolean {
    return this.selectionErrorFor(questionId) !== undefined;
  }

  customErrorFor(questionId: string): boolean {
    return this.customError === questionId;
  }

  allAnswered(): boolean {
    return this.questions.every((question) => this.answers.has(question.id));
  }

  /** Tab index of the first question with no answer, or undefined when complete. */
  firstUnansweredTab(): number | undefined {
    const index = this.questions.findIndex((question) => !this.answers.has(question.id));
    return index >= 0 ? index : undefined;
  }

  /** Recorded answers in question order, skipping unanswered questions. */
  answersInQuestionOrder(): Answer[] {
    return this.questions.flatMap((question) => {
      const answer = this.answers.get(question.id);
      return answer ? [answer] : [];
    });
  }

  /** Move the cursor, reporting whether its visible row changed. */
  moveCursor(delta: number): boolean {
    const options = this.currentOptions();
    const next = Math.min(Math.max(0, this.optionIndex + delta), Math.max(0, options.length - 1));
    if (next === this.optionIndex) return false;
    this.optionIndex = next;
    this.touch();
    return true;
  }

  /** Place the cursor on a visible row, ignoring out-of-range targets. */
  moveCursorTo(index: number): boolean {
    const options = this.currentOptions();
    if (index < 0 || index >= options.length) return false;
    if (index === this.optionIndex) return true;
    this.optionIndex = index;
    this.touch();
    return true;
  }

  /** Move between question tabs and the review tab, wrapping at both ends. */
  moveTab(delta: number): void {
    if (this.totalTabs <= 1) return;
    this.currentTab = (this.currentTab + delta + this.totalTabs) % this.totalTabs;
    this.stopFiltering();
    this.selectionError = null;
    this.syncCursorToAnswer();
    this.touch();
  }

  /** Jump straight to a tab index, used when review shows a missing answer. */
  moveToTab(index: number): void {
    if (index < 0 || index >= this.totalTabs || index === this.currentTab) return;
    this.currentTab = index;
    this.stopFiltering();
    this.selectionError = null;
    this.syncCursorToAnswer();
    this.touch();
  }

  startFiltering(): void {
    const question = this.currentQuestion();
    if (!question || this.filteringQuestionId === question.id) return;
    this.filteringQuestionId = question.id;
    this.selectionError = null;
    this.touch();
  }

  /** Leave filter mode, keeping whatever filter text was already applied. */
  stopFiltering(): void {
    if (this.filteringQuestionId === null) return;
    this.filteringQuestionId = null;
    this.touch();
  }

  /** Leave filter mode and restore the full option list. */
  clearFilter(): void {
    const questionId = this.filteringQuestionId ?? this.currentQuestion()?.id;
    this.filteringQuestionId = null;
    if (questionId && this.filters.has(questionId)) {
      this.filters.delete(questionId);
      this.clampCursor();
    }
    this.touch();
  }

  /** Longest filter text accepted, well past any useful option prefix. */
  static readonly MAX_FILTER_LENGTH = 64;

  appendFilter(text: string): void {
    const question = this.currentQuestion();
    if (!question || this.filteringQuestionId !== question.id) return;
    const current = this.filterFor(question.id);
    if ([...current].length >= QuestionnaireState.MAX_FILTER_LENGTH) return;
    // Filter text is rendered live, so it is hardened on the way in rather
    // than only when an answer is recorded.
    const safe = stripUnsafeCharacters(text);
    if (!safe) return;
    this.filters.set(question.id, `${current}${safe}`);
    this.clampCursor();
    this.touch();
  }

  /** Remove the last filter character, leaving filter mode when it empties. */
  backspaceFilter(): void {
    const question = this.currentQuestion();
    if (!question || this.filteringQuestionId !== question.id) return;
    const current = this.filterFor(question.id);
    if (!current) {
      this.filteringQuestionId = null;
      this.touch();
      return;
    }
    const next = [...current].slice(0, -1).join("");
    if (next) this.filters.set(question.id, next);
    else this.filters.delete(question.id);
    this.clampCursor();
    this.touch();
  }

  startCustomInput(question: Question): void {
    this.editingQuestionId = question.id;
    this.filteringQuestionId = null;
    this.selectionError = null;
    this.customError = null;
    this.touch();
  }

  cancelCustomInput(): void {
    if (this.editingQuestionId === null) return;
    this.editingQuestionId = null;
    this.customError = null;
    this.touch();
  }

  clearCustomError(): void {
    if (this.customError === null) return;
    this.customError = null;
    this.touch();
  }

  /**
   * Record free-text input for the question being edited. Blank input is
   * rejected with an inline error and leaves edit mode active. On a
   * multi-select question the text is added alongside the chosen options
   * instead of replacing them, and a text that would break the selection
   * bounds is rejected the same way blank input is.
   */
  submitCustomInput(value: string): boolean {
    const questionId = this.editingQuestionId;
    if (!questionId) return false;
    const question = this.questions.find((item) => item.id === questionId);
    if (!question) return false;

    const text = sanitizeUserInput(value, question.otherMaxLength);
    if (!text) {
      this.customError = questionId;
      this.touch();
      return false;
    }

    if (question.multiSelect) {
      // The text counts as one selection, so it can push the question over
      // `maxSelections`. Reject it before it displaces anything, and drop any
      // previously confirmed answer the same way a toggle would, so review
      // cannot submit a value the user has since moved away from.
      const selected = this.multiSelections.get(questionId)?.size ?? 0;
      if (this.wouldExceedMaximum(question, selected + 1)) {
        this.selectionError = { id: questionId, kind: "max" };
        this.customError = null;
        this.editingQuestionId = null;
        this.answers.delete(questionId);
        this.touch();
        return true;
      }
      this.customError = null;
      this.editingQuestionId = null;
      this.multiCustom.set(questionId, text);
      this.confirmMultiAnswer(question);
      return true;
    }

    this.customError = null;
    this.editingQuestionId = null;
    this.answers.set(questionId, { id: questionId, kind: "custom", value: text, label: text });
    this.multiSelections.delete(questionId);
    this.multiCustom.delete(questionId);
    this.advanceAfterAnswer();
    return true;
  }

  saveSingleAnswer(question: Question, optionIndex: number): void {
    const option = question.options[optionIndex];
    if (!option) return;
    this.answers.set(question.id, {
      id: question.id,
      kind: "single",
      value: option.value,
      label: option.label,
      index: optionIndex + 1,
    });
    this.multiCustom.delete(question.id);
    this.advanceAfterAnswer();
  }

  /** Record an optional question as intentionally unanswered. */
  skipQuestion(question: Question): void {
    if (!question.optional) return;
    this.answers.set(question.id, { id: question.id, kind: "skipped" });
    this.multiSelections.delete(question.id);
    this.multiCustom.delete(question.id);
    this.selectionError = null;
    this.advanceAfterAnswer();
  }

  /**
   * Toggle one option of a multi-select question, which also clears any
   * confirmed answer. Selecting past `maxSelections` is refused, counting any
   * free-text addition as one selection.
   */
  toggleMultiSelection(question: Question, optionIndex: number): boolean {
    if (!question.options[optionIndex]) return false;
    const selections = new Set(this.multiSelections.get(question.id) ?? []);
    if (selections.has(optionIndex)) {
      selections.delete(optionIndex);
    } else {
      const custom = this.multiCustom.get(question.id) ? 1 : 0;
      if (this.wouldExceedMaximum(question, selections.size + custom + 1)) {
        this.selectionError = { id: question.id, kind: "max" };
        this.touch();
        return false;
      }
      selections.add(optionIndex);
    }
    this.multiSelections.set(question.id, selections);
    this.answers.delete(question.id);
    this.selectionError = null;
    this.touch();
    return true;
  }

  /** Select every real option, refused when that would exceed `maxSelections`. */
  selectAll(question: Question): boolean {
    if (!question.multiSelect) return false;
    const custom = this.multiCustom.get(question.id) ? 1 : 0;
    if (this.wouldExceedMaximum(question, question.options.length + custom)) {
      this.selectionError = { id: question.id, kind: "max" };
      this.touch();
      return false;
    }
    this.multiSelections.set(question.id, new Set(question.options.map((_option, index) => index)));
    this.answers.delete(question.id);
    this.selectionError = null;
    this.touch();
    return true;
  }

  /** Clear every selection and any free-text addition. */
  clearSelections(question: Question): void {
    if (!question.multiSelect) return;
    const hadSelections = (this.multiSelections.get(question.id)?.size ?? 0) > 0;
    const hadCustom = this.multiCustom.has(question.id);
    if (!hadSelections && !hadCustom && !this.answers.has(question.id)) return;
    this.multiSelections.delete(question.id);
    this.multiCustom.delete(question.id);
    this.answers.delete(question.id);
    this.selectionError = null;
    this.touch();
  }

  /**
   * Confirm the current multi-select question. The free-text addition counts as
   * one selection, so `minSelections: 1` is satisfied by text alone.
   */
  confirmMultiAnswer(question: Question): boolean {
    const selectedIndexes = [...(this.multiSelections.get(question.id) ?? [])].sort((a, b) => a - b);
    const custom = this.multiCustom.get(question.id);
    const total = selectedIndexes.length + (custom ? 1 : 0);

    if (total < question.minSelections) {
      this.selectionError = { id: question.id, kind: "min" };
      this.touch();
      return false;
    }
    if (this.wouldExceedMaximum(question, total)) {
      this.selectionError = { id: question.id, kind: "max" };
      this.touch();
      return false;
    }

    this.answers.set(question.id, {
      id: question.id,
      kind: "multi",
      selections: selectedIndexes.flatMap((index) => {
        const option = question.options[index];
        return option ? [{ value: option.value, label: option.label, index: index + 1 }] : [];
      }),
      ...(custom ? { custom } : {}),
    });
    this.selectionError = null;
    this.advanceAfterAnswer();
    return true;
  }

  /** Settle the questionnaire once; later calls are ignored. */
  submit(cancelled: boolean, reason: CancelReason = "user"): void {
    if (this.settled) return;
    this.settled = true;
    this.onSettled({
      questions: this.questions,
      answers: this.answersInQuestionOrder(),
      cancelled,
      ...(cancelled ? { cancelReason: reason } : {}),
    });
  }

  private wouldExceedMaximum(question: Question, total: number): boolean {
    return question.maxSelections !== undefined && total > question.maxSelections;
  }

  /** Pre-select `defaultValues` and pre-confirm nothing; the user still acts. */
  private applyDefaults(): void {
    for (const question of this.questions) {
      if (question.defaultValues.length === 0) continue;
      if (!question.multiSelect) continue;
      const indexes = question.defaultValues.flatMap((value) => {
        const index = question.options.findIndex((option) => option.value === value);
        return index >= 0 ? [index] : [];
      });
      if (indexes.length > 0) this.multiSelections.set(question.id, new Set(indexes));
    }
  }

  /**
   * Put the cursor on the row the user would expect: their existing answer, the
   * question's default, or the first row. Free-text and skipped answers resolve
   * to their synthetic row so Enter does not silently replace them.
   */
  private syncCursorToAnswer(): void {
    this.optionIndex = 0;
    const question = this.currentQuestion();
    if (!question) return;

    const target = this.cursorTargetFor(question);
    if (target === undefined) return;

    const options = this.currentOptions();
    const row =
      target.kind === "option"
        ? options.findIndex((option) => option.optionIndex === target.index)
        : options.findIndex((option) => (target.kind === "other" ? option.isOther : option.isSkip));
    if (row >= 0) this.optionIndex = row;
  }

  /** Row the cursor should rest on, or undefined for the first row. */
  private cursorTargetFor(question: Question): CursorTarget | undefined {
    const answer = this.answers.get(question.id);
    if (answer?.kind === "single") return { kind: "option", index: answer.index - 1 };
    if (answer?.kind === "custom") return { kind: "other" };
    if (answer?.kind === "skipped") return { kind: "skip" };
    if (answer?.kind === "multi") {
      const [first] = answer.selections;
      if (first) return { kind: "option", index: first.index - 1 };
      return answer.custom ? { kind: "other" } : undefined;
    }

    const selections = this.multiSelections.get(question.id);
    if (selections && selections.size > 0) return { kind: "option", index: Math.min(...selections) };

    const [firstDefault] = question.defaultValues;
    if (firstDefault === undefined) return undefined;
    const index = question.options.findIndex((option) => option.value === firstDefault);
    return index >= 0 ? { kind: "option", index } : undefined;
  }

  private clampCursor(): void {
    const options = this.currentOptions();
    this.optionIndex = Math.min(this.optionIndex, Math.max(0, options.length - 1));
  }

  /**
   * Single-question runs submit as soon as they are answered, unless the
   * question asked for review. Otherwise move to the next unanswered question,
   * or to the review tab when none is left.
   */
  private advanceAfterAnswer(): void {
    if (!this.hasReviewTab) {
      this.submit(false);
      return;
    }
    this.currentTab = this.nextTabAfterAnswer();
    this.stopFiltering();
    this.selectionError = null;
    this.syncCursorToAnswer();
    this.touch();
  }

  /** The next unanswered question at or after the current tab, else review. */
  private nextTabAfterAnswer(): number {
    for (let offset = 1; offset <= this.questions.length; offset++) {
      const index = (this.currentTab + offset) % this.questions.length;
      const question = this.questions[index];
      if (question && !this.answers.has(question.id)) return index;
    }
    return this.questions.length;
  }

  private touch(): void {
    this.revision += 1;
  }
}
