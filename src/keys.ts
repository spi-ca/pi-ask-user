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
};

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
 * rebinding a key takes effect. The one exception is an action the manager
 * reports as having no keys at all. This prompt is modal, so an unbound
 * `confirm` would make it impossible to answer; such an action falls back to its
 * built-in key and the help text names that key, keeping display and behavior
 * aligned. Defaults also apply when no usable manager was supplied or when it
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
      // Help text must never fail rendering.
      return undefined;
    }
  }

  function keysFor(action: SelectAction): readonly string[] {
    const keys = resolvedKeys(action);
    return keys && keys.length > 0 ? keys : FALLBACK_KEYS[action];
  }

  return {
    matches(data, action) {
      if (manager) {
        try {
          if (manager.matches(data, SELECT_BINDINGS[action]) === true) return true;
          // Only a manager that reports an empty key list tells us the action is
          // unbound; anything else is an authoritative rejection.
          const resolved = resolvedKeys(action);
          if (resolved === undefined || resolved.length > 0) return false;
        } catch {
          // A throwing manager cannot be trusted either way, so fall back to
          // the defaults rather than leaving the questionnaire unusable.
        }
      }
      return FALLBACK_KEYS[action].some((keyId) => matchesKey(data, keyId));
    },
    label(action) {
      const [first] = keysFor(action);
      return keyLabel(first ?? FALLBACK_KEYS[action][0]!);
    },
  };
}
