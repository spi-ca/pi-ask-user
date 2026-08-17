// `ask_user` tool registration.
//
// Validates parameters, opens the interactive component, and shapes the result.
// Presence is optional bookkeeping around the call and never gates it. The tool
// runs in `sequential` mode so two questionnaires cannot fight over the TUI.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createQuestionnaireComponent, type QuestionnaireComponent } from "./component.ts";
import { AskUserPresence, PRESENCE_READY_EVENT } from "./presence.ts";
import { answerLabels, answerValues, normalizeQuestions, QuestionnaireParams } from "./questions.ts";
import { answerPrefix } from "./render.ts";
import { sanitizeDisplayText } from "./sanitize.ts";
import type { Answer, CancelReason, Question, QuestionnaireResult } from "./types.ts";

export const TOOL_NAME = "ask_user";
export const TOOL_LABEL = "Ask User";
export const TOOL_DESCRIPTION =
  "Ask one or more option questions. Set multiSelect for multiple answers, optional to allow skipping, " +
  "defaultValues to preselect, and min/maxSelections to bound choices. Custom input defaults on.";
export const NON_INTERACTIVE_MESSAGE = "Error: UI not available (running in non-interactive mode)";
export const CANCELLED_MESSAGE = "User cancelled the questionnaire";

/** Labels rendered on the collapsed call line before it is elided. */
export const MAX_CALL_LINE_LABELS = 8;
/** Per-label cap on the collapsed call line. */
export const MAX_CALL_LINE_LABEL_LENGTH = 60;
/** Cap on fallback result text that never passed through normalization. */
export const MAX_FALLBACK_TEXT_LENGTH = 500;

interface ToolErrorResult {
  content: { type: "text"; text: string }[];
  details: QuestionnaireResult;
}

/** Error and non-interactive results are reported as a cancelled questionnaire. */
export function errorResult(
  message: string,
  questions: Question[] = [],
  reason: CancelReason = "invalid",
): ToolErrorResult {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true, cancelReason: reason },
  };
}

/**
 * One result line for an answer, carrying both label and machine value.
 *
 * The model only sees the text content, so the values it must echo back have to
 * appear here. Values are omitted when they match the label to avoid noise.
 */
export function formatAnswerLine(question: Question | undefined, answer: Answer): string {
  const label = question?.label || answer.id;
  if (answer.kind === "skipped") return `${label}: (skipped)`;

  const labels = answerLabels(answer);
  const values = answerValues(answer);
  const joinedValues = values.join(", ");
  if (answer.kind === "custom" || joinedValues === labels) return `${label}: ${labels}`;
  return `${label}: ${labels} [${joinedValues}]`;
}

/** Plain-text tool output: one `label: answer` line per answered question. */
export function formatResultText(result: QuestionnaireResult): string {
  return result.answers
    .map((answer) =>
      formatAnswerLine(
        result.questions.find((item) => item.id === answer.id),
        answer,
      ),
    )
    .join("\n");
}

/** Cancellation text, naming the reason so the agent can decide what to do. */
export function formatCancelledText(result: QuestionnaireResult): string {
  const reason = result.cancelReason ?? "user";
  const detail =
    reason === "aborted"
      ? "the tool call was aborted"
      : reason === "unavailable"
        ? "no interactive UI was available"
        : "the user cancelled";
  const answered = formatResultText(result);
  const header = `${CANCELLED_MESSAGE} (${detail})`;
  return answered ? `${header}\nAnswered so far:\n${answered}` : header;
}

/**
 * Question labels shown in the collapsed tool-call line.
 *
 * This runs on raw arguments before normalization, so it caps how much it reads
 * and sanitizes what it keeps.
 */
export function callLabels(args: unknown): { count: number; labels: string } {
  const rawQuestions =
    args && typeof args === "object" && Array.isArray((args as { questions?: unknown }).questions)
      ? (args as { questions: unknown[] }).questions
      : [];
  const questions = rawQuestions.filter(
    (question): question is { id?: unknown; label?: unknown; prompt?: unknown } =>
      question !== null && typeof question === "object",
  );
  const labels = questions
    .slice(0, MAX_CALL_LINE_LABELS)
    .map((question) =>
      typeof question.label === "string"
        ? question.label
        : typeof question.id === "string"
          ? question.id
          : typeof question.prompt === "string"
            ? question.prompt
            : "Question",
    )
    .map((label) => sanitizeDisplayText(label, MAX_CALL_LINE_LABEL_LENGTH))
    .join(", ");
  const suffix = questions.length > MAX_CALL_LINE_LABELS ? ", …" : "";
  return { count: questions.length, labels: labels ? `${labels}${suffix}` : "" };
}

export function registerAskUserTool(pi: ExtensionAPI): void {
  const presence = new AskUserPresence(pi);
  pi.events.on(PRESENCE_READY_EVENT, (payload) => presence.handleReady(payload));
  pi.on("session_start", (_event, ctx) => presence.startSession(ctx));
  pi.on("session_shutdown", () => presence.stopSession());

  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description: TOOL_DESCRIPTION,
    parameters: QuestionnaireParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return errorResult(NON_INTERACTIVE_MESSAGE, [], "unavailable");
      }

      const normalized = normalizeQuestions(params);
      if (typeof normalized === "string") {
        return errorResult(normalized);
      }
      const questions = normalized;
      const presenceToken = presence.beginRequest(ctx);
      let component: QuestionnaireComponent | null = null;
      let cancelRequested = false;

      // Cancellation must work in either order: the component may not exist yet
      // when the signal aborts, and the signal may abort before the factory runs.
      const cancel = () => {
        cancelRequested = true;
        component?.cancel("aborted");
      };

      try {
        const questionnaire = ctx.ui.custom<QuestionnaireResult>((tui, theme, keybindings, done) => {
          const mounted = createQuestionnaireComponent({
            questions,
            tui,
            theme,
            keybindings,
            done: (result) => {
              component = null;
              done(result);
            },
          });
          component = mounted;
          // An abort that arrived before mounting settles the component now; the
          // component itself is still returned so the host can dispose it.
          if (cancelRequested) mounted.cancel("aborted");
          return mounted;
        });

        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });

        const result = await questionnaire;
        if (result.cancelled) {
          return {
            content: [{ type: "text", text: formatCancelledText(result) }],
            details: result,
          };
        }

        return {
          content: [{ type: "text", text: formatResultText(result) }],
          details: result,
        };
      } finally {
        component = null;
        try {
          signal?.removeEventListener("abort", cancel);
        } finally {
          presence.finishRequest(presenceToken);
        }
      }
    },

    renderCall(args, theme, _context) {
      const { count, labels } = callLabels(args);
      let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) text += theme.fg("dim", ` (${labels})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        // Without details the text never passed through normalization; it can be
        // a host-side schema error carrying the original arguments.
        const text = result.content[0];
        const raw = text?.type === "text" ? text.text : "";
        return new Text(sanitizeDisplayText(raw, MAX_FALLBACK_TEXT_LENGTH, true), 0, 0);
      }
      if (details.cancelled) {
        const reason = details.cancelReason ?? "user";
        const suffix = reason === "user" ? "" : ` (${reason})`;
        return new Text(theme.fg("warning", `Cancelled${suffix}`), 0, 0);
      }
      const lines = details.answers.map((answer) => {
        const question = details.questions.find((item) => item.id === answer.id);
        const body = `${answerPrefix(answer)}${answerLabels(answer)}`;
        const marker = answer.kind === "skipped" ? theme.fg("dim", "– ") : theme.fg("success", "✓ ");
        return `${marker}${theme.fg("accent", question?.label || answer.id)}: ${theme.fg("text", body)}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
