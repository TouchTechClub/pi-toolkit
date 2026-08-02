# pi-oc-question — Opencode-Inspired Ask-the-User Questions

A Pi coding-agent extension providing a unified `question` tool that asks the user questions during execution — opencode's `question` tool molded for pi.

## Key Details

- **Tool name**: `question`
- **Schema** (opencode shape): `{ questions: [{ question, header, options: [{ label, description? }], multiple?, custom? }] }`
- **Answers**: `string[][]` — one array per question, in question order, each an array of selected labels
- **Multi-select**: `multiple: true` toggles options; rendered as `[✓]` rows in TUI
- **Custom answers**: `custom !== false` (default) adds a "Type your own answer" option
- **Digit shortcuts**: `1-9` pick an option directly in TUI
- **Recommended convention**: first option + "(Recommended)" suffix, enforced via `promptGuidelines`

## Mode Strategy

- **TUI** (`ctx.mode === "tui"`): rich `ctx.ui.custom()` dialog — tab bar for multiple questions, final Confirm tab, multi-select toggles, inline editor for custom answers, digit shortcuts.
- **RPC** (`ctx.mode === "rpc"`): decomposes into `ctx.ui.select()` / `ctx.ui.input()` per question, which emit `extension_ui_request` events that hosts like S5 Code (t3code) auto-route to their structured user-input surface. Multi-select degrades to comma-separated free text (`ctx.ui.input()`), parsed back to `string[]`.
- **print/json**: returns a clear error — the tool needs an interactive session.
- **Dismiss**: any cancelled dialog cancels the entire tool (opencode `reject` parity).

## Code Location

- Source: `packages/oc-question/index.ts`
- Published as: `@touchtechclub/pi-oc-question`
- License: MIT
