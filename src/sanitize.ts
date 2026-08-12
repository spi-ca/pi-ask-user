// Display-text hardening for untrusted question content.
//
// Question text is authored by the model, and the model reads files, command
// output, and web pages. Any of those can carry terminal escape sequences, so
// every string that reaches the screen or the tool result is stripped of
// control and bidi-affecting characters before it is used.

/** Longest display string kept intact; longer input is truncated with an ellipsis. */
export const MAX_DISPLAY_LENGTH = 1000;
/** Longest machine value accepted; longer input is rejected instead of truncated. */
export const MAX_VALUE_LENGTH = 200;
/** Most lines one display string may span, so a prompt cannot fill the view. */
export const MAX_DISPLAY_LINES = 20;

const ELLIPSIS = "…";

function isUnsafeCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x08 ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * Remove escape, control, and bidi-affecting characters.
 *
 * `allowNewlines` keeps `\n` for multi-line prompts; every other layout
 * character (`\t`, `\r`, and vertical tabs) collapses to a single space so a
 * label can never break the option grid.
 *
 * `limit` stops the scan once that many code points have been kept, so an
 * oversized input costs work proportional to the limit rather than to its own
 * length. Callers that will truncate afterwards should pass `limit + 1` so the
 * truncation can still tell "exactly at the limit" from "longer".
 */
export function stripUnsafeCharacters(value: string, allowNewlines = false, limit = Number.POSITIVE_INFINITY): string {
  let result = "";
  let kept = 0;
  let afterCarriageReturn = false;
  for (const character of value) {
    if (kept >= limit) break;
    const codePoint = character.codePointAt(0) ?? 0;

    if (codePoint === 0x0d) {
      // Fold CR and CRLF into one break without a separate normalization pass.
      afterCarriageReturn = true;
      result += allowNewlines ? "\n" : " ";
      kept += 1;
      continue;
    }
    if (codePoint === 0x0a) {
      if (afterCarriageReturn) {
        afterCarriageReturn = false;
        continue;
      }
      result += allowNewlines ? "\n" : " ";
      kept += 1;
      continue;
    }
    afterCarriageReturn = false;

    if (codePoint === 0x09) {
      result += " ";
      kept += 1;
      continue;
    }
    if (isUnsafeCodePoint(codePoint)) continue;
    result += character;
    kept += 1;
  }
  return result;
}

/** Truncate to `limit` code points, marking the cut with an ellipsis. */
export function truncateCodePoints(value: string, limit: number): string {
  const codePoints = [...value];
  if (codePoints.length <= limit) return value;
  return `${codePoints.slice(0, Math.max(0, limit - 1)).join("")}${ELLIPSIS}`;
}

/** Collapse blank-line runs and cap how many lines one string may span. */
function capLines(value: string): string {
  const collapsed = value.replace(/\n{3,}/g, "\n\n");
  const lines = collapsed.split("\n");
  if (lines.length <= MAX_DISPLAY_LINES) return collapsed;
  return `${lines.slice(0, MAX_DISPLAY_LINES).join("\n")}\n${ELLIPSIS}`;
}

/**
 * Sanitize one display string: unsafe characters removed, code points capped,
 * and line count capped when newlines are allowed. Truncation is preferred over
 * rejection so long prompts stay usable.
 */
export function sanitizeDisplayText(value: string, limit = MAX_DISPLAY_LENGTH, allowNewlines = false): string {
  const stripped = stripUnsafeCharacters(value, allowNewlines, limit + 1);
  return truncateCodePoints(allowNewlines ? capLines(stripped) : stripped, limit);
}

/** True when a machine value is short enough to be carried in a tool result. */
export function isValueLengthAllowed(value: string): boolean {
  // Bail out early instead of materializing every code point of a huge string.
  if (value.length > MAX_VALUE_LENGTH * 2) return false;
  return [...value].length <= MAX_VALUE_LENGTH;
}

/** Sanitize a machine value. Length is checked separately so callers can error. */
export function sanitizeValue(value: string): string {
  return stripUnsafeCharacters(value, false, MAX_VALUE_LENGTH + 1);
}

/** Sanitize free-text input from the user, capping it at the question's limit. */
export function sanitizeUserInput(value: string, limit: number): string {
  return truncateCodePoints(stripUnsafeCharacters(value.trim(), false, limit + 1), limit);
}
