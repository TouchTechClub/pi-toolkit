# @touchtechclub/pi-oc-question

Opencode-inspired Pi extension that lets the agent ask the user questions during execution — gather preferences, clarify ambiguous instructions, get decisions, and offer choices. Mirrors opencode's `question` tool shape, molded for pi's TUI and RPC (`ctx.ui.*`) surfaces.

## Features

- **Unified `question` tool** — one tool for single or multiple questions
- **Multi-select** — `multiple: true` lets the user pick several options
- **Custom answers** — "Type your own answer" option (on by default, `custom: false` to disable)
- **Rich TUI dialog** — tab bar for multi-question flows, final Confirm tab, digit shortcuts (1-9), inline editor for custom text
- **RPC-compatible** — in `rpc` mode questions decompose into `ctx.ui.select()` / `ctx.ui.input()` calls, which hosts like S5 Code auto-route to their structured user-input surface
- **Recommended convention** — first option + "(Recommended)" guidance baked into `promptGuidelines`

## Install

```bash
pi extension add @touchtechclub/pi-oc-question
```

For local development, add to `.pi/settings.json`:

```json
{
  "packages": ["../packages/oc-question"]
}
```

## Usage

The extension registers a single `question` tool that Pi calls automatically whenever it needs user input:

```text
question
  questions: [
    {
      "question": "Which database should we use?",
      "header": "Database",
      "options": [
        { "label": "SQLite (Recommended)", "description": "Zero setup, file-based" },
        { "label": "Postgres", "description": "Full-featured server" }
      ],
      "multiple": false,
      "custom": true
    }
  ]
```

### Schema

| Field | Type | Notes |
|---|---|---|
| `questions` | `Question[]` | 1..n questions to ask |
| `question` | `string` | The full question text |
| `header` | `string` | Short tab label (max 30 chars) |
| `options` | `Option[]` | `{ label, description? }`; recommended option first with `(Recommended)` |
| `multiple` | `boolean?` | Allow multiple selections (default `false`) |
| `custom` | `boolean?` | Allow "Type your own answer" (default `true`) |

Answers come back to the model as arrays of selected labels, one array per question, in question order.

## Mode behavior

- **TUI**: full interactive dialog (tabs, multi-select, digit shortcuts, custom editor).
- **RPC**: one `select`/`input` dialog per question (multi-select becomes comma-separated free text).
- **print / json**: returns an error — no interactive session.
- **Dismiss**: cancelling any dialog cancels the whole tool.

## License

MIT
