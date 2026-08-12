import { expect, test } from "bun:test";
import {
  isValueLengthAllowed,
  MAX_DISPLAY_LINES,
  MAX_VALUE_LENGTH,
  sanitizeDisplayText,
  sanitizeUserInput,
  sanitizeValue,
  stripUnsafeCharacters,
  truncateCodePoints,
} from "../src/sanitize.ts";

test("strips escape and C0 control characters", () => {
  expect(stripUnsafeCharacters("a\u001b[2Jb")).toBe("a[2Jb");
  expect(stripUnsafeCharacters("a\u0007b")).toBe("ab");
  expect(stripUnsafeCharacters("a\u0000b")).toBe("ab");
  expect(stripUnsafeCharacters("a\u0008b")).toBe("ab");
});

test("strips C1 control characters, including the 8-bit CSI", () => {
  expect(stripUnsafeCharacters("a\u009bb")).toBe("ab");
  expect(stripUnsafeCharacters("a\u0080b")).toBe("ab");
});

test("strips bidi controls and line separators", () => {
  expect(stripUnsafeCharacters("a\u202eb")).toBe("ab");
  expect(stripUnsafeCharacters("a\u2066b\u2069c")).toBe("abc");
  expect(stripUnsafeCharacters("a\u200eb\u200fc\u061cd")).toBe("abcd");
  expect(stripUnsafeCharacters("a\u2028b\u2029c")).toBe("abc");
});

test("collapses tabs and carriage returns to spaces", () => {
  expect(stripUnsafeCharacters("a\tb")).toBe("a b");
  expect(stripUnsafeCharacters("a\r\nb")).toBe("a b");
  expect(stripUnsafeCharacters("a\rb")).toBe("a b");
});

test("newlines survive only when explicitly allowed", () => {
  expect(stripUnsafeCharacters("a\nb")).toBe("a b");
  expect(stripUnsafeCharacters("a\nb", true)).toBe("a\nb");
  expect(stripUnsafeCharacters("a\r\nb", true)).toBe("a\nb");
});

test("keeps ordinary text, emoji, and CJK intact", () => {
  expect(stripUnsafeCharacters("한국어 English 🙂")).toBe("한국어 English 🙂");
});

test("truncateCodePoints counts code points, not UTF-16 units", () => {
  expect(truncateCodePoints("abcdef", 10)).toBe("abcdef");
  expect(truncateCodePoints("abcdef", 4)).toBe("abc…");
  expect([...truncateCodePoints("🙂".repeat(10), 4)].length).toBe(4);
});

test("sanitizeDisplayText strips then truncates", () => {
  expect(sanitizeDisplayText("a\u001b[2Jbcdef", 4)).toBe("a[2…");
});

test("sanitizeDisplayText keeps a string that lands exactly on the limit", () => {
  expect(sanitizeDisplayText("abcd", 4)).toBe("abcd");
  expect(sanitizeDisplayText("abcde", 4)).toBe("abc…");
});

test("sanitizeDisplayText collapses blank-line runs and caps line count", () => {
  expect(sanitizeDisplayText("a\n\n\n\nb", 100, true)).toBe("a\n\nb");

  const many = sanitizeDisplayText(Array.from({ length: 40 }, (_unused, i) => `line${i}`).join("\n"), 1000, true);
  expect(many.split("\n")).toHaveLength(MAX_DISPLAY_LINES + 1);
  expect(many.endsWith("…")).toBe(true);
});

test("sanitizeValue strips control characters and stops past the value limit", () => {
  expect(sanitizeValue("va\u0007lue")).toBe("value");
  // Scanning stops one past the limit so callers can still detect "too long".
  expect([...sanitizeValue("v".repeat(500))].length).toBe(MAX_VALUE_LENGTH + 1);
});

test("stripUnsafeCharacters stops once the limit is reached", () => {
  expect(stripUnsafeCharacters("abcdef", false, 3)).toBe("abc");
  // Removed characters do not consume the budget.
  expect(stripUnsafeCharacters("\u0007a\u0007b\u0007c", false, 2)).toBe("ab");
});

test("CRLF folds to one break even when the limit cuts between them", () => {
  expect(stripUnsafeCharacters("a\r\nb", true)).toBe("a\nb");
  // The limit is reached on the CR, so the LF is never examined; the result
  // must still not contain a stray second break.
  expect(stripUnsafeCharacters("a\r\nb", true, 2)).toBe("a\n");
  expect(stripUnsafeCharacters("a\r\nb", true, 3)).toBe("a\nb");
  expect(stripUnsafeCharacters("a\r\nb", false, 2)).toBe("a ");
});

test("a lone CR still becomes one break", () => {
  expect(stripUnsafeCharacters("a\rb", true)).toBe("a\nb");
  expect(stripUnsafeCharacters("a\r\r\nb", true)).toBe("a\n\nb");
});

test("isValueLengthAllowed uses the machine value limit", () => {
  expect(isValueLengthAllowed("v".repeat(MAX_VALUE_LENGTH))).toBe(true);
  expect(isValueLengthAllowed("v".repeat(MAX_VALUE_LENGTH + 1))).toBe(false);
});

test("sanitizeUserInput trims, strips, and caps at the given limit", () => {
  expect(sanitizeUserInput("  hello  ", 100)).toBe("hello");
  expect(sanitizeUserInput("  \u001b[2Jhello  ", 100)).toBe("[2Jhello");
  expect(sanitizeUserInput("abcdefgh", 4)).toBe("abc…");
  expect(sanitizeUserInput("   ", 100)).toBe("");
});
