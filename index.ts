/**
 * pi-ask-user
 *
 * Registers the `ask_user` tool: an interactive questionnaire in the Pi TUI that
 * asks one or more option questions, supports multi-select and free-text
 * answers, and returns structured answers to the agent.
 *
 * The extension adds no slash commands and no background work. It optionally
 * emits process-local presence events so a consumer such as `pi-cmux-presence`
 * can show a "waiting for input" state while a question is open.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserTool } from "./src/tool.ts";

export default function askUser(pi: ExtensionAPI): void {
  registerAskUserTool(pi);
}
