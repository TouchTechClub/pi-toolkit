import type { AgentToolResult, ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

// ACP PlanEntry-compatible types.  No extra fields, no unsupported statuses.
type TodoStatus = 'pending' | 'in_progress' | 'completed'
type TodoPriority = 'high' | 'medium' | 'low'

interface TodoItem {
  id: number
  content: string
  status: TodoStatus
  priority: TodoPriority
}

const TodoItemSchema = Type.Object({
  id: Type.Optional(
    Type.Number({ description: 'Numeric identifier for the task. Auto-assigned if omitted.' }),
  ),
  content: Type.String({ description: 'Brief description of the task' }),
  status: Type.String({
    description: 'Current status of the task: pending, in_progress, completed',
  }),
  priority: Type.String({ description: 'Priority level of the task: high, medium, low' }),
})

const TodoWriteParams = Type.Object({
  todos: Type.Array(TodoItemSchema, { description: 'The complete updated todo list' }),
})

const PatchTodoParams = Type.Object({
  id: Type.Number({ description: 'Numeric ID of the task to update' }),
  status: Type.Optional(
    Type.String({
      description: 'New status for the task: pending, in_progress, completed',
    }),
  ),
  priority: Type.Optional(
    Type.String({ description: 'New priority for the task: high, medium, low' }),
  ),
  content: Type.Optional(Type.String({ description: 'Updated task description text' })),
})

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed'])
const VALID_PRIORITIES = new Set(['high', 'medium', 'low'])

const TODOWRITE_DESCRIPTION = `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and give the user visibility into your progress.

Use todowrite proactively for complex or multi-step work, when the user explicitly asks for a todo list, when the user gives multiple tasks, after receiving new instructions, and after completing tasks so statuses stay current.

Do not use todowrite for a single straightforward task, trivial changes, commands with immediate results, or purely conversational/informational requests.

Each task has a numeric id assigned automatically. Task status values:
- pending: Task not yet started
- in_progress: Currently working on the task (ideally keep at most ONE item in_progress)
- completed: Task finished successfully

Task priority values:
- high: Urgent or important work
- medium: Normal priority work
- low: Nice-to-have or less urgent work

Update the todo list in real time as you work. Mark tasks completed immediately after finishing them; do not batch completions. When you start a task, mark it in_progress. The todos argument must be the complete updated list, not a partial patch.

Use patchtodo to update the status of a single task without rewriting the entire list.`

const PATCHTODO_DESCRIPTION = `Update a single task's status (or other fields) by its numeric ID without having to rewrite the entire todo list.

Use patchtodo when you only need to change one task — for example, marking a single task as completed or in_progress. This is more efficient than calling todowrite with the full list.

You must provide the task id. You may optionally provide a new status, priority, or content. Only the fields you specify will be updated; unspecified fields keep their current values.

Task status values: pending, in_progress, completed
Task priority values: high, medium, low`

function normalizeTodo(
  todo: Partial<TodoItem> & Record<string, unknown>,
): Omit<TodoItem, 'id'> & { id?: number } {
  const status = String(todo.status ?? 'pending')
    .trim()
    .toLowerCase()
  const priority = String(todo.priority ?? 'medium')
    .trim()
    .toLowerCase()
  const result: Omit<TodoItem, 'id'> & { id?: number } = {
    content: String(todo.content ?? '').trim(),
    status: status as TodoStatus,
    priority: priority as TodoPriority,
  }
  if (typeof todo.id === 'number' && Number.isFinite(todo.id) && todo.id > 0) {
    result.id = Math.floor(todo.id)
  }
  return result
}

function validateTodos(input: Array<Partial<TodoItem> & Record<string, unknown>>): TodoItem[] {
  const normalized = input.map(normalizeTodo)
  const errors: string[] = []

  normalized.forEach((todo, index) => {
    if (!todo.content) errors.push(`todos[${index}].content must be non-empty`)
    if (!VALID_STATUSES.has(todo.status)) {
      errors.push(`todos[${index}].status must be one of: pending, in_progress, completed`)
    }
    if (!VALID_PRIORITIES.has(todo.priority)) {
      errors.push(`todos[${index}].priority must be one of: high, medium, low`)
    }
  })

  if (errors.length > 0) throw new Error(errors.join('; '))

  // Assign IDs: keep explicit IDs, auto-assign sequential IDs for the rest
  let nextId = 1
  for (const todo of normalized) {
    if (todo.id !== undefined && todo.id >= nextId) {
      nextId = todo.id + 1
    }
  }

  return normalized.map((todo) => ({
    id: todo.id ?? nextId++,
    content: todo.content,
    status: todo.status,
    priority: todo.priority,
  }))
}

function statusIcon(status: TodoStatus, theme: Theme) {
  switch (status) {
    case 'completed':
      return theme.fg('success', '✓')
    case 'in_progress':
      return theme.fg('warning', '◐')
    default:
      return theme.fg('dim', '○')
  }
}

function formatTodos(todos: TodoItem[], theme: Theme, expanded: boolean) {
  if (todos.length === 0) return theme.fg('dim', 'No todos')

  const remaining = todos.filter((todo) => todo.status !== 'completed').length
  let text = `${theme.fg('toolTitle', theme.bold('todowrite'))} ${theme.fg('muted', `${remaining} remaining / ${todos.length} total`)}`
  const display = expanded ? todos : todos.slice(0, 8)

  for (const todo of display) {
    const content =
      todo.status === 'completed'
        ? theme.fg('dim', todo.content)
        : theme.fg('toolOutput', todo.content)
    text += `\n${statusIcon(todo.status, theme)} ${theme.fg('dim', `[${todo.id}]`)} ${content} ${theme.fg('dim', `[${todo.status}, ${todo.priority}]`)}`
  }

  if (!expanded && todos.length > display.length) {
    text += `\n${theme.fg('dim', `... ${todos.length - display.length} more`)}`
  }

  return text
}

function todosFromResult(
  result: AgentToolResult<{ todos?: TodoItem[] } | undefined>,
): TodoItem[] | undefined {
  if (Array.isArray(result.details?.todos)) return result.details.todos
  const text = result.content.find((content) => content.type === 'text')?.text
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed)
      ? validateTodos(parsed as Array<Partial<TodoItem> & Record<string, unknown>>)
      : undefined
  } catch {
    return undefined
  }
}

export default function (pi: ExtensionAPI) {
  let todos: TodoItem[] = []
  let nextId = 1

  // Reconstruct state from session on start/reload
  pi.on('session_start', async (_event, ctx) => {
    todos = []
    nextId = 1
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'message') continue
      if (entry.message.role !== 'toolResult') continue
      if (entry.message.toolName !== 'todowrite' && entry.message.toolName !== 'patchtodo') continue

      const items = entry.message.details?.todos as TodoItem[] | undefined
      if (Array.isArray(items) && items.length > 0) {
        todos = items
        nextId = Math.max(...items.map((t) => t.id), 0) + 1
      }
    }
  })

  pi.registerTool({
    name: 'todowrite',
    label: 'todowrite',
    description: TODOWRITE_DESCRIPTION,
    promptSnippet: 'Create and update a structured task list for the current coding session',
    promptGuidelines: [
      'Use todowrite to plan and track complex or multi-step work; skip it for single trivial tasks and purely informational requests.',
      'Update todowrite as work progresses: mark one task in_progress when starting it, mark tasks completed immediately, and keep the list current.',
      'When calling todowrite, pass the complete updated todo list, not a partial patch. Use patchtodo to update a single task by ID.',
      'Each task gets a numeric id. Reference task ids when using patchtodo for single-task updates.',
    ],
    parameters: TodoWriteParams,

    async execute(_toolCallId, params) {
      const result = validateTodos(
        params.todos as Array<Partial<TodoItem> & Record<string, unknown>>,
      )

      todos = result
      nextId = Math.max(...result.map((t) => t.id), 0) + 1

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: { todos: result },
      }
    },

    renderCall(args, theme) {
      const items = Array.isArray(args?.todos)
        ? validateTodos(args.todos as Array<Partial<TodoItem> & Record<string, unknown>>)
        : []
      return new Text(
        `${theme.fg('toolTitle', theme.bold('todowrite'))} ${theme.fg('muted', `${items.length} todo${items.length === 1 ? '' : 's'}`)}`,
        0,
        0,
      )
    },

    renderResult(result, options, theme) {
      const items = todosFromResult(result as AgentToolResult<{ todos?: TodoItem[] } | undefined>)
      if (items) return new Text(formatTodos(items, theme, options.expanded), 0, 0)
      const text = result.content
        .filter((content) => content.type === 'text')
        .map((content) => content.text || '')
        .join('\n')
      return new Text(text, 0, 0)
    },
  })

  pi.registerTool({
    name: 'patchtodo',
    label: 'patchtodo',
    description: PATCHTODO_DESCRIPTION,
    promptSnippet:
      'Update a single task in the todo list by its numeric ID without rewriting all tasks',
    promptGuidelines: [
      'Use patchtodo to update the status of a single task without rewriting the entire todo list with todowrite.',
      'Provide the task id (number) and optionally a new status, priority, or content. Unspecified fields keep their current values.',
      'Call patchtodo when marking a single task as in_progress or completed to avoid resending the full list.',
    ],
    parameters: PatchTodoParams,

    async execute(_toolCallId, params) {
      const id = params.id as number
      const status = params.status as string | undefined
      const priority = params.priority as string | undefined
      const content = params.content as string | undefined

      const index = todos.findIndex((t) => t.id === id)
      if (index === -1) {
        throw new Error(
          `Task with id ${id} not found. Available ids: ${todos.map((t) => t.id).join(', ') || 'none'}`,
        )
      }

      if (status !== undefined) {
        const normalized = String(status).trim().toLowerCase()
        if (!VALID_STATUSES.has(normalized)) {
          throw new Error(
            `Invalid status "${status}". Must be one of: pending, in_progress, completed`,
          )
        }
        todos[index] = { ...todos[index], status: normalized as TodoStatus }
      }

      if (priority !== undefined) {
        const normalized = String(priority).trim().toLowerCase()
        if (!VALID_PRIORITIES.has(normalized)) {
          throw new Error(`Invalid priority "${priority}". Must be one of: high, medium, low`)
        }
        todos[index] = { ...todos[index], priority: normalized as TodoPriority }
      }

      if (content !== undefined) {
        const trimmed = String(content).trim()
        if (!trimmed) {
          throw new Error('content must be non-empty when provided')
        }
        todos[index] = { ...todos[index], content: trimmed }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Patched task ${id}: ${JSON.stringify(todos[index], null, 2)}`,
          },
        ],
        details: { todos },
      }
    },

    renderCall(args, theme) {
      const id = typeof args?.id === 'number' ? args.id : '?'
      const parts: string[] = []
      if (args?.status) parts.push(`status → ${args.status}`)
      if (args?.priority) parts.push(`priority → ${args.priority}`)
      const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
      return new Text(
        `${theme.fg('toolTitle', theme.bold('patchtodo'))} ${theme.fg('muted', `#${id}${suffix}`)}`,
        0,
        0,
      )
    },

    renderResult(result, options, theme) {
      const items = todosFromResult(result as AgentToolResult<{ todos?: TodoItem[] } | undefined>)
      if (items) {
        const id =
          result.details && typeof result.details === 'object'
            ? (result.details as Record<string, unknown>).patchedId
            : undefined
        const patched = id !== undefined ? items.find((t) => t.id === id) : undefined
        let text: string
        if (patched) {
          text = `${theme.fg('success', '✓')} ${theme.fg('dim', `[${patched.id}]`)} ${theme.fg('toolOutput', patched.content)} ${theme.fg('dim', `[${patched.status}, ${patched.priority}]`)}`
          if (options.expanded) {
            text +=
              '\n' +
              theme.fg('dim', `Full list: ${items.length} todo${items.length === 1 ? '' : 's'}`)
          }
        } else {
          text = formatTodos(items, theme, options.expanded)
        }
        return new Text(text, 0, 0)
      }
      const text = result.content
        .filter((content) => content.type === 'text')
        .map((content) => content.text || '')
        .join('\n')
      return new Text(text, 0, 0)
    },
  })
}
