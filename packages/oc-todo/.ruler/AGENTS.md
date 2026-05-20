# pi-oc-todo — Opencode-Inspired Todo Tracking

A Pi coding-agent extension that provides a `todowrite` tool for tracking tasks during coding sessions. Outputs ACP plan-compatible JSON.

## Key Details

- **Tool name**: `todowrite` (also recognized as `todo`, `TodoWrite` by the ACP translator)
- **Statuses**: `pending`, `in_progress`, `completed` (matches ACP `PlanEntryStatus`)
- **Priorities**: `high`, `medium`, `low` (matches ACP `PlanEntryPriority`)
- **Output**: JSON array of `{ content, status, priority }` in text content + `details.todos`

## Usage

Pi uses `todowrite` automatically during complex multi-step tasks. The ACP adapter (`pi-acp`) translates the tool output into `sessionUpdate: "plan"` events for ACP clients.

## Code Location

- Source: `packages/oc-todo/index.ts`
- Published as: `@touchtechclub/pi-oc-todo`
- License: MIT
