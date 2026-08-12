// `ask_user` tool registration.
//
// Validates parameters, opens the interactive component, and shapes the result.
// Presence is optional bookkeeping around the call and never gates it. The tool
// runs in `sequential` mode so two questionnaires cannot fight over the TUI.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createQuestionnaireComponent, type QuestionnaireComponent } from "./component.ts";
import { AskUserPresence, PRESENCE_READY_EVENT } from "./presence.ts";
import { answerLabels, normalizeQuestions, QuestionnaireParams } from "./questions.ts";
import { answerPrefix } from "./render.ts";
import type { Question, QuestionnaireResult } from "./types.ts";

export const TOOL_NAME = "ask_user";
export const TOOL_LABEL = "Ask User";
export const TOOL_DESCRIPTION =
  "Ask one or more option questions; set multiSelect for multiple answers. Custom input defaults on.";
export const NON_INTERACTIVE_MESSAGE = "Error: UI not available (running in non-interactive mode)";
export const CANCELLED_MESSAGE = "User cancelled the questionnaire";

interface ToolErrorResult {
  content: { type: "text"; text: string }[];
  details: QuestionnaireResult;
}

/** Error and non-interactive results are reported as a cancelled questionnaire. */
export function errorResult(message: string, questions: Question[] = []): ToolErrorResult {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

/** Plain-text tool output: one `label: answer` line per answered question. */
export function formatResultText(result: QuestionnaireResult): string {
  return result.answers
    .map((answer) => {
      const question = result.questions.find((item) => item.id === answer.id);
      return `${question?.label || answer.id}: ${answerLabels(answer)}`;
    })
    .join("\n");
}

/** Question labels shown in the collapsed tool-call line. */
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
    .map((question) =>
      typeof question.label === "string"
        ? question.label
        : typeof question.id === "string"
          ? question.id
          : typeof question.prompt === "string"
            ? question.prompt
            : "Question",
    )
    .join(", ");
  return { count: questions.length, labels };
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
        return errorResult(NON_INTERACTIVE_MESSAGE);
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
        component?.cancel();
      };

      const questionnaire = ctx.ui.custom<QuestionnaireResult>((tui, theme, _keybindings, done) => {
        const mounted = createQuestionnaireComponent({
          questions,
          tui,
          theme,
          done: (result) => {
            component = null;
            done(result);
          },
        });
        component = mounted;
        // An abort that arrived before mounting settles the component now; the
        // component itself is still returned so the host can dispose it.
        if (cancelRequested) mounted.cancel();
        return mounted;
      });

      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });

      try {
        const result = await questionnaire;
        if (result.cancelled) {
          return {
            content: [{ type: "text", text: CANCELLED_MESSAGE }],
            details: result,
          };
        }

        return {
          content: [{ type: "text", text: formatResultText(result) }],
          details: result,
        };
      } finally {
        signal?.removeEventListener("abort", cancel);
        component = null;
        presence.finishRequest(presenceToken);
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
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      const lines = details.answers.map((answer) => {
        const question = details.questions.find((item) => item.id === answer.id);
        const body = `${answerPrefix(answer)}${answerLabels(answer)}`;
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", question?.label || answer.id)}: ${theme.fg("text", body)}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
