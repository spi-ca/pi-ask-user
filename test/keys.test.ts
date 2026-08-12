import { expect, test } from "bun:test";
import { createKeyResolver, keyLabel, SELECT_BINDINGS } from "../src/keys.ts";

const ENTER = "\r";
const ESCAPE = "\u001b";
const DOWN = "\u001b[B";

test("keyLabel renders arrows, named keys, and modifiers", () => {
  expect(keyLabel("up")).toBe("↑");
  expect(keyLabel("enter")).toBe("Enter");
  expect(keyLabel("escape")).toBe("Esc");
  expect(keyLabel("ctrl+s")).toBe("Ctrl+S");
  expect(keyLabel("ctrl+shift+p")).toBe("Ctrl+Shift+P");
  expect(keyLabel("pageDown")).toBe("PgDn");
  expect(keyLabel("f5")).toBe("f5");
});

test("a missing manager falls back to the built-in select keys", () => {
  const resolver = createKeyResolver(undefined);
  expect(resolver.matches(ENTER, "confirm")).toBe(true);
  expect(resolver.matches(ESCAPE, "cancel")).toBe(true);
  expect(resolver.matches(DOWN, "down")).toBe(true);
  expect(resolver.matches(DOWN, "up")).toBe(false);
  expect(resolver.label("confirm")).toBe("Enter");
});

test("a malformed manager is ignored rather than trusted", () => {
  const resolver = createKeyResolver({ matches: "not a function" });
  expect(resolver.matches(ENTER, "confirm")).toBe(true);
});

test("a manager's bindings are consulted and its labels are used", () => {
  const seen: string[] = [];
  const resolver = createKeyResolver({
    matches(data: string, keybinding: string) {
      seen.push(keybinding);
      return keybinding === SELECT_BINDINGS.confirm && data === "\u0013";
    },
    getKeys: (keybinding: string) => (keybinding === SELECT_BINDINGS.confirm ? ["ctrl+s"] : []),
  });

  expect(resolver.matches("\u0013", "confirm")).toBe(true);
  expect(seen).toContain("tui.select.confirm");
  expect(resolver.label("confirm")).toBe("Ctrl+S");
});

test("a usable manager is authoritative, so a rebound key no longer fires", () => {
  const resolver = createKeyResolver({
    matches: (data: string, keybinding: string) => keybinding === SELECT_BINDINGS.confirm && data === "\u0013",
  });
  expect(resolver.matches("\u0013", "confirm")).toBe(true);
  // Enter was rebound away from confirm, so it must not still confirm.
  expect(resolver.matches(ENTER, "confirm")).toBe(false);
});

test("a non-boolean match result is not treated as a match", () => {
  const resolver = createKeyResolver({ matches: () => "yes" as unknown as boolean });
  expect(resolver.matches(ENTER, "confirm")).toBe(false);
});

test("an action the manager reports as unbound falls back so the prompt stays usable", () => {
  // This prompt is modal: an unbound confirm would make it unanswerable.
  const resolver = createKeyResolver({
    matches: () => false,
    getKeys: () => [],
  });
  expect(resolver.matches(ENTER, "confirm")).toBe(true);
  expect(resolver.label("confirm")).toBe("Enter");
});

test("a rejection with keys still bound is authoritative", () => {
  const resolver = createKeyResolver({
    matches: (data: string, keybinding: string) => keybinding === SELECT_BINDINGS.confirm && data === "\u0013",
    getKeys: (keybinding: string) => (keybinding === SELECT_BINDINGS.confirm ? ["ctrl+s"] : ["x"]),
  });
  expect(resolver.matches("\u0013", "confirm")).toBe(true);
  expect(resolver.matches(ENTER, "confirm")).toBe(false);
});

test("a manager without getKeys is trusted rather than second-guessed", () => {
  const resolver = createKeyResolver({ matches: () => false });
  expect(resolver.matches(ENTER, "confirm")).toBe(false);
  expect(resolver.label("confirm")).toBe("Enter");
});

test("malformed key ids are dropped from labels", () => {
  const resolver = createKeyResolver({
    matches: () => false,
    getKeys: () => [42 as unknown as string, "x".repeat(200), "bogus+s", "ctrl+ctrl+s", "ctrl+s"],
  });
  expect(resolver.label("confirm")).toBe("Ctrl+S");
});

test("the editor submit binding is resolved separately from select confirm", () => {
  const resolver = createKeyResolver({
    matches: () => false,
    getKeys: (keybinding: string) => (keybinding === SELECT_BINDINGS.submit ? ["ctrl+m"] : ["ctrl+s"]),
  });
  expect(resolver.label("submit")).toBe("Ctrl+M");
  expect(resolver.label("confirm")).toBe("Ctrl+S");
});

test("key labels are sanitized before they reach the screen", () => {
  expect(keyLabel("ctrl+\u001b[2Js")).not.toContain("\u001b");
  expect(keyLabel("\u009bx")).not.toContain("\u009b");
});

test("a throwing manager cannot lock input or break help text", () => {
  const resolver = createKeyResolver({
    matches() {
      throw new Error("broken");
    },
    getKeys() {
      throw new Error("broken");
    },
  });

  expect(resolver.matches(ENTER, "confirm")).toBe(true);
  expect(resolver.label("confirm")).toBe("Enter");
});

test("an empty key list falls back to the default label", () => {
  const resolver = createKeyResolver({
    matches: () => false,
    getKeys: () => [],
  });
  expect(resolver.label("cancel")).toBe("Esc");
});

test("a manager without getKeys still produces default labels", () => {
  const resolver = createKeyResolver({ matches: () => false });
  expect(resolver.label("confirm")).toBe("Enter");
  expect(resolver.label("up")).toBe("↑");
  expect(resolver.label("submit")).toBe("Enter");
});
