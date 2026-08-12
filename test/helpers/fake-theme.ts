// Test-only theme and TUI doubles.
//
// The component only needs `fg`/`bg`/`bold` from the theme and
// `requestRender`/`terminal` from the TUI. Styling is identity so rendered lines
// stay assertable as plain text.

export interface FakeTui {
  requestRender(): void;
  renderCount(): number;
  terminal: { cols: number; rows: number };
}

/** Theme double whose styling helpers return text unchanged. */
export function fakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
  };
}

/** TUI double that counts render requests instead of drawing. */
export function fakeTui(cols = 80, rows = 24): FakeTui {
  let renders = 0;
  return {
    requestRender() {
      renders += 1;
    },
    renderCount() {
      return renders;
    },
    terminal: { cols, rows },
  };
}
