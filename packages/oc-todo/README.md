# @touchtechclub/pi-oc-todo

Opencode-inspired Pi extension for structured todo list tracking.

## Features

- Create and manage task lists during coding sessions
- Track status (`pending`, `in_progress`, `completed`) and priority (`high`, `medium`, `low`)
- Numeric task IDs for precise single-task updates via `patchtodo`
- Patch individual tasks by ID without rewriting the entire list
- ACP plan-compatible — outputs clean `PlanEntry[]` JSON for Agent Client Protocol clients
- TUI rendering with status icons, task IDs, and expand/collapse

## Install

```bash
pi extension add @touchtechclub/pi-oc-todo
```

## Usage

The extension registers two tools that Pi uses automatically. You can also invoke them as slash commands:

```text
/todowrite
/patchtodo
```

### todowrite

Create or update the full task list. Each task gets a numeric `id` assigned automatically.

### patchtodo

Update a single task's status, priority, or content by its numeric ID — without rewriting the entire list. Ideal for quickly marking a task as `in_progress` or `completed`.

## License

MIT
