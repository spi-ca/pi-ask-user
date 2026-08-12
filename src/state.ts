// Questionnaire state machine, independent of the TUI.
//
// Owns tab position, option cursor, multi-select toggles, recorded answers,
// validation errors, and single-shot settlement. The interactive component maps
// keys onto these transitions and renders the resulting snapshot, which keeps
// navigation and answer semantics testable without a terminal.

import { buildRenderOptions } from "./render.ts";
import type { Answer, Question, QuestionnaireResult, QuestionOption, RenderOption } from "./types.ts";

export interface QuestionnaireStateOptions {
  questions: Question[];
  /** Called exactly once when the questionnaire settles. */
  onSettled: (result: QuestionnaireResult) => void;
}

export class QuestionnaireState {
  /** Index of the focused question, or `questions.length` for the review tab. */
  currentTab = 0;
  /** Cursor position within the current option list, including the custom entry. */
  optionIndex = 0;
  /** Bumped on every mutation so the component can skip redundant renders. */
  revision = 0;

  private readonly questions: Question[];
  private readonly onSettled: (result: QuestionnaireResult) => void;
  private readonly answers = new Map<string, Answer>();
  private readonly multiSelections = new Map<string, Set<number>>();
  private editingQuestionId: string | null = null;
  private multiError: string | null = null;
  private customError: string | null = null;
  private settled = false;

  constructor(options: QuestionnaireStateOptions) {
    this.questions = options.questions;
    this.onSettled = options.onSettled;
  }

  get hasMultipleQuestions(): boolean {
    return this.questions.length > 1;
  }

  /** Question tabs plus the trailing review tab. */
  get totalTabs(): number {
    return this.questions.length + 1;
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

  get onReviewTab(): boolean {
    return this.currentTab === this.questions.length;
  }

  currentQuestion(): Question | undefined {
    return this.questions[this.currentTab];
  }

  currentOptions(): RenderOption[] {
    return buildRenderOptions(this.currentQuestion());
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

  selectionsFor(questionId: string): ReadonlySet<number> {
    return this.multiSelections.get(questionId) ?? new Set<number>();
  }

  multiErrorFor(questionId: string): boolean {
    return this.multiError === questionId;
  }

  customErrorFor(questionId: string): boolean {
    return this.customError === questionId;
  }

  allAnswered(): boolean {
    return this.questions.every((question) => this.answers.has(question.id));
  }

  /** Recorded answers in question order, skipping unanswered questions. */
  answersInQuestionOrder(): Answer[] {
    return this.questions.flatMap((question) => {
      const answer = this.answers.get(question.id);
      return answer ? [answer] : [];
    });
  }

  moveCursor(delta: number): void {
    const options = this.currentOptions();
    const next = Math.min(Math.max(0, this.optionIndex + delta), Math.max(0, options.length - 1));
    if (next === this.optionIndex) return;
    this.optionIndex = next;
    this.touch();
  }

  /** Move between question tabs and the review tab, wrapping at both ends. */
  moveTab(delta: number): void {
    if (!this.hasMultipleQuestions) return;
    this.currentTab = (this.currentTab + delta + this.totalTabs) % this.totalTabs;
    this.optionIndex = 0;
    this.multiError = null;
    this.touch();
  }

  startCustomInput(question: Question): void {
    this.editingQuestionId = question.id;
    this.multiError = null;
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
   * rejected with an inline error and leaves edit mode active.
   */
  submitCustomInput(value: string): boolean {
    const questionId = this.editingQuestionId;
    if (!questionId) return false;
    const trimmed = value.trim();
    if (!trimmed) {
      this.customError = questionId;
      this.touch();
      return false;
    }
    this.answers.set(questionId, { id: questionId, kind: "custom", value: trimmed, label: trimmed });
    this.multiSelections.delete(questionId);
    this.customError = null;
    this.editingQuestionId = null;
    this.advanceAfterAnswer();
    return true;
  }

  saveSingleAnswer(question: Question, option: QuestionOption, index: number): void {
    this.answers.set(question.id, {
      id: question.id,
      kind: "single",
      value: option.value,
      label: option.label,
      index: index + 1,
    });
    this.advanceAfterAnswer();
  }

  /** Toggle one multi-select option, which also clears any confirmed answer. */
  toggleMultiSelection(question: Question, index: number): void {
    const selections = new Set(this.multiSelections.get(question.id) ?? []);
    if (selections.has(index)) selections.delete(index);
    else selections.add(index);
    this.multiSelections.set(question.id, selections);
    this.answers.delete(question.id);
    this.multiError = null;
    this.touch();
  }

  /** Confirm the current multi-select question, requiring at least one option. */
  confirmMultiAnswer(question: Question): boolean {
    const selectedIndexes = [...(this.multiSelections.get(question.id) ?? [])].sort((a, b) => a - b);
    if (selectedIndexes.length === 0) {
      this.multiError = question.id;
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
    });
    this.multiError = null;
    this.advanceAfterAnswer();
    return true;
  }

  /** Settle the questionnaire once; later calls are ignored. */
  submit(cancelled: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.onSettled({
      questions: this.questions,
      answers: this.answersInQuestionOrder(),
      cancelled,
    });
  }

  /**
   * Single-question runs submit as soon as they are answered. Multi-question
   * runs move to the next question, or to the review tab at the end.
   */
  private advanceAfterAnswer(): void {
    if (!this.hasMultipleQuestions) {
      this.submit(false);
      return;
    }
    this.currentTab = this.currentTab < this.questions.length - 1 ? this.currentTab + 1 : this.questions.length;
    this.optionIndex = 0;
    this.multiError = null;
    this.touch();
  }

  private touch(): void {
    this.revision += 1;
  }
}
