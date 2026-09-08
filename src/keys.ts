// Key matching that honors the user's keybindings when one is available.
//
// `ctx.ui.custom` hands the component a `KeybindingsManager`, so navigation and
// confirmation follow the same bindings as the rest of Pi. Tests and older
// hosts may pass nothing, in which case the built-in defaults apply.

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "./sanitize.ts";

/** The bindings this component reuses from Pi's own actions. */
export const SELECT_BINDINGS = {
  up: "tui.select.up",
  down: "tui.select.down",
  confirm: "tui.select.confirm",
  cancel: "tui.select.cancel",
  /** The embedded editor submits on this binding, not on select.confirm. */
  submit: "tui.input.submit",
  /** Needed to avoid stealing Enter when an editor uses it for a newline. */
  newLine: "tui.input.newLine",
} as const;

export type SelectAction = keyof typeof SELECT_BINDINGS;

/** Structural view of `KeybindingsManager`, kept narrow so tests can fake it. */
export interface KeybindingsLike {
  matches(data: string, keybinding: string): boolean;
  getKeys?(keybinding: string): readonly string[];
}

const FALLBACK_KEYS: Record<SelectAction, KeyId[]> = {
  up: ["up"],
  down: ["down"],
  confirm: ["enter"],
  cancel: ["escape"],
  submit: ["enter"],
  newLine: ["shift+enter", "ctrl+j"],
};

/** Raw input Pi delivers for each built-in fallback key. */
const FALLBACK_INPUTS: Partial<Record<KeyId, string>> = {
  up: "\u001b[A",
  down: "\u001b[B",
  enter: "\r",
  escape: "\u001b",
};

/** These select-list actions share a key-dispatch context in this component. */
const SELECT_ACTIONS: readonly SelectAction[] = ["up", "down", "confirm", "cancel"];

const KEY_LABELS: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  enter: "Enter",
  return: "Enter",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Del",
  pageUp: "PgUp",
  pageDown: "PgDn",
};

const MODIFIER_LABELS: Record<string, string> = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  super: "Super",
};

function isKeybindingsLike(value: unknown): value is KeybindingsLike {
  return typeof value === "object" && value !== null && typeof (value as KeybindingsLike).matches === "function";
}

/** Resolved matcher and display labels for the actions this component uses. */
export interface KeyResolver {
  matches(data: string, action: SelectAction): boolean;
  label(action: SelectAction): string;
  /** Whether the embedded editor has a non-conflicting way to submit text. */
  canSubmit(): boolean;
}

/** Longest key id accepted from a manager, e.g. `ctrl+shift+pageDown`. */
const MAX_KEY_ID_LENGTH = 32;

const MODIFIER_NAMES = new Set(["ctrl", "shift", "alt", "super"]);

/**
 * A key id must look like the ids Pi's own bindings use: zero or more distinct
 * known modifiers followed by a single non-empty base key.
 */
function isKeyIdLike(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_KEY_ID_LENGTH) return false;
  const parts = value.split("+");
  const base = parts.pop();
  if (!base) return false;
  const seen = new Set<string>();
  for (const modifier of parts) {
    if (!MODIFIER_NAMES.has(modifier) || seen.has(modifier)) return false;
    seen.add(modifier);
  }
  return true;
}

/** Human-readable form of a key id, e.g. `ctrl+s` becomes `Ctrl+S`. */
export function keyLabel(keyId: string): string {
  const parts = keyId.split("+");
  const base = parts.pop() ?? keyId;
  const label = KEY_LABELS[base] ?? (base.length === 1 ? base.toUpperCase() : base);
  const modifiers = parts.map((modifier) => MODIFIER_LABELS[modifier] ?? modifier);
  // Key ids come from user configuration, so the label is hardened like any
  // other string that reaches the screen.
  return sanitizeDisplayText([...modifiers, label].join("+"), MAX_KEY_ID_LENGTH);
}

/**
 * Build a resolver from an untrusted `keybindings` argument.
 *
 * A usable manager is authoritative: a binding it rejects stays rejected, so
 * rebinding a key takes effect. An empty action may use a built-in fallback
 * only when no *configured sibling action* claims that input; otherwise a
 * fallback could override the user's configured dispatch. Submit is stricter:
 * its Enter fallback is available only when no configured editor action claims
 * Enter. Defaults also apply when no usable manager was supplied or when it
 * throws.
 */
export function createKeyResolver(keybindings: unknown): KeyResolver {
  const manager = isKeybindingsLike(keybindings) ? keybindings : undefined;

  /** Resolved key ids, or undefined when the manager could not be consulted. */
  function resolvedKeys(action: SelectAction): readonly string[] | undefined {
    if (!manager?.getKeys) return undefined;
    try {
      const keys = manager.getKeys(SELECT_BINDINGS[action]);
      return Array.isArray(keys) ? keys.filter(isKeyIdLike) : undefined;
    } catch {
      // A broken key-list API cannot make this modal unusable. Treat that
      // action as unbound; matches() failures take the same fallback path.
      return [];
    }
  }

  // Keep submit's fallback behind Pi's editor dispatch order: configuration
  // may legitimately assign Enter to any of these actions, not just newLine.
  const editorActions = [
    SELECT_BINDINGS.newLine,
    "tui.input.tab",
    "tui.input.copy",
    ...SELECT_ACTIONS.map((action) => SELECT_BINDINGS[action]),
    "tui.editor.cursorUp",
    "tui.editor.cursorDown",
    "tui.editor.cursorLeft",
    "tui.editor.cursorRight",
    "tui.editor.cursorWordLeft",
    "tui.editor.cursorWordRight",
    "tui.editor.cursorLineStart",
    "tui.editor.cursorLineEnd",
    "tui.editor.jumpForward",
    "tui.editor.jumpBackward",
    "tui.editor.pageUp",
    "tui.editor.pageDown",
    "tui.editor.deleteCharBackward",
    "tui.editor.deleteCharForward",
    "tui.editor.deleteWordBackward",
    "tui.editor.deleteWordForward",
    "tui.editor.deleteToLineStart",
    "tui.editor.deleteToLineEnd",
    "tui.editor.yank",
    "tui.editor.yankPop",
    "tui.editor.undo",
    "tui.editor.historyPrevious",
    "tui.editor.historyNext",
  ];

  function configuredActionClaims(data: string, keyId: string, keybinding: string): boolean {
    if (!manager) return false;
    // getKeys establishes that this is a configured action; its exact key IDs
    // cover fakes and managers that do not expose a raw-input matcher for every
    // key spelling. matches additionally catches equivalent spellings such as
    // an Enter sequence reported as "return".
    const configured = resolvedKeysForBinding(keybinding);
    if (!configured) return false;
    if (configured.includes(keyId)) return true;
    try {
      return manager.matches(data, keybinding) === true;
    } catch {
      return false;
    }
  }

  function resolvedKeysForBinding(keybinding: string): readonly string[] | undefined {
    if (!manager?.getKeys) return undefined;
    try {
      const keys = manager.getKeys(keybinding);
      return Array.isArray(keys) ? keys.filter(isKeyIdLike) : undefined;
    } catch {
      return [];
    }
  }

  function fallbackKeysFor(action: SelectAction): readonly KeyId[] {
    const configured = resolvedKeys(action);
    if (configured === undefined || configured.length > 0 || !manager) return FALLBACK_KEYS[action];
    const siblingBindings =
      action === "submit"
        ? editorActions
        : SELECT_ACTIONS.filter((candidate) => candidate !== action).map((candidate) => SELECT_BINDINGS[candidate]);
    return FALLBACK_KEYS[action].filter((keyId) => {
      const data = FALLBACK_INPUTS[keyId];
      // No raw input representation means this fallback is never dispatched by
      // this component, so it cannot make a help hint truthful or usable.
      return data !== undefined && !siblingBindings.some((binding) => configuredActionClaims(data, keyId, binding));
    });
  }

  function keysFor(action: SelectAction): readonly string[] {
    const keys = resolvedKeys(action);
    return keys && keys.length > 0 ? keys : fallbackKeysFor(action);
  }

  function canSubmit(): boolean {
    if (!manager) return true;
    const resolved = resolvedKeys("submit");
    // A manager that cannot report its keys can still match a configured submit
    // action at runtime, so retain the editor instead of hiding it preemptively.
    return resolved === undefined || resolved.length > 0 || fallbackKeysFor("submit").length > 0;
  }

  return {
    matches(data, action) {
      if (manager) {
        try {
          if (manager.matches(data, SELECT_BINDINGS[action]) === true) return true;
          // Only a manager that reports an empty key list tells us the action is
          // unbound; anything else is an authoritative rejection. Submit may
          // borrow Enter only when that key is not claimed by the editor.
          const resolved = resolvedKeys(action);
          if (resolved === undefined || resolved.length > 0) return false;
          const fallback = fallbackKeysFor(action);
          return fallback.some((keyId) => matchesKey(data, keyId));
        } catch {
          // A throwing manager cannot be trusted either way, so fall back to
          // the defaults rather than leaving the questionnaire unusable.
        }
      }
      return fallbackKeysFor(action).some((keyId) => matchesKey(data, keyId));
    },
    label(action) {
      const [first] = keysFor(action);
      return first ? keyLabel(first) : "Unbound";
    },
    canSubmit,
  };
}
