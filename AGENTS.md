# AGENTS.md

Entry point for coding agents working in this repository.

## Project

`pi-ask-user` is a Pi extension package that registers one tool, `ask_user`.
It asks the user single or multiple option questions in the Pi TUI, supports
multi-select and free-text answers, and returns structured answers to the
agent. It optionally emits process-local presence events for a consumer such
as `pi-cmux-presence`.

## Runtime

Use `bun` (see `packageManager` in `package.json`), not `npm`/`npx`.

```bash
bun install --frozen-lockfile
```

## Validation

```bash
bun run ci
```

`bun run ci` runs `bun run lint`, `bun run check` (type check via `tsc --noEmit`),
and `bun test` in that order, and is the required check before treating a change as
verified. `bun run lint`, `bun run test`, and `bun run check` also exist individually. See
[`docs/development.md`](docs/development.md) for what the suite does and does
not cover.

## Cross-Cutting Rules

- Do not move or rename the root `index.ts`. The `package.json`
  `pi.extensions` manifest references it directly as the extension entry point.
- Internal modules live in a flat `src/`; `test/` mirrors that layout plus a
  `helpers/` directory. See the project structure block in
  [`docs/development.md`](docs/development.md) before adding a file.
- Keep answer semantics in `src/state.ts` and TUI concerns in
  `src/component.ts`. Do not move state transitions into the component.
- Validate untrusted tool arguments in `src/questions.ts` before opening any
  UI, and return error strings instead of throwing.
- Presence is observer-only. It uses the shared `@pi/presence` producer, must
  never fail, delay, or gate a question, and must never carry question, option,
  answer, cancel reason, or session ID content.
- Language follows the reader. Docs written for people — `README.md` and
  `docs/*.md` — are Korean. Docs written for agents — this file — are English.
  Match the surrounding document instead of mixing languages.
- Commit messages follow `.gitmessage`: Korean, conventional type prefix, no
  `Co-Authored-By` trailer.

## Focused Docs

| Doc | Use For |
|-----|---------|
| [`docs/usage.md`](docs/usage.md) | Tool call shape, validation rules, answer format |
| [`docs/configuration.md`](docs/configuration.md) | Presence event contract and privacy scope |
| [`docs/development.md`](docs/development.md) | Setup, verification, project structure, invariants |
