# @touchtechclub/pi-oc-todo

Opencode-inspired Pi extension for structured todo list tracking.

## Features

- Create and manage task lists during coding sessions
- Track status (`pending`, `in_progress`, `completed`) and priority (`high`, `medium`, `low`)
- ACP plan-compatible — outputs clean `PlanEntry[]` JSON for Agent Client Protocol clients
- TUI rendering with status icons and expand/collapse

## Install

```bash
pi extension add @touchtechclub/pi-oc-todo
```

## Usage

The extension registers a `todowrite` tool that Pi uses automatically. You can also invoke it as a slash command:

```text
/todowrite
```

## License

MIT
