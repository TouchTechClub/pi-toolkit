import type { AgentToolResult, ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

// ACP PlanEntry-compatible types.  No extra fields, no unsupported statuses.
type TodoStatus = 'pending' | 'in_progress' | 'completed'
type TodoPriority = 'high' | 'medium' | 'low'

interface TodoItem {
  content: string
  status: TodoStatus
  priority: TodoPriority
}

const TodoItemSchema = Type.Object({
  content: Type.String({ description: 'Brief description of the task' }),
  status: Type.String({
    description: 'Current status of the task: pending, in_progress, completed',
  }),
  priority: Type.String({ description: 'Priority level of the task: high, medium, low' }),
})

const TodoWriteParams = Type.Object({
  todos: Type.Array(TodoItemSchema, { description: 'The complete updated todo list' }),
})

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed'])
const VALID_PRIORITIES = new Set(['high', 'medium', 'low'])

const DESCRIPTION = `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and give the user visibility into your progress.

Use todowrite proactively for complex or multi-step work, when the user explicitly asks for a todo list, when the user gives multiple tasks, after receiving new instructions, and after completing tasks so statuses stay current.

Do not use todowrite for a single straightforward task, trivial changes, commands with immediate results, or purely conversational/informational requests.

Task status values:
- pending: Task not yet started
- in_progress: Currently working on the task (ideally keep at most ONE item in_progress)
- completed: Task finished successfully

Task priority values:
- high: Urgent or important work
- medium: Normal priority work
- low: Nice-to-have or less urgent work

Update the todo list in real time as you work. Mark tasks completed immediately after finishing them; do not batch completions. When you start a task, mark it in_progress. The todos argument must be the complete updated list, not a patch.`

function normalizeTodo(todo: Partial<TodoItem> & Record<string, unknown>): TodoItem {
  const status = String(todo.status ?? 'pending')
    .trim()
    .toLowerCase()
  const priority = String(todo.priority ?? 'medium')
    .trim()
    .toLowerCase()
  return {
    content: String(todo.content ?? '').trim(),
    status: status as TodoStatus,
    priority: priority as TodoPriority,
  }
}

function validateTodos(input: Array<Partial<TodoItem> & Record<string, unknown>>): TodoItem[] {
  const todos = input.map(normalizeTodo)
  const errors: string[] = []

  todos.forEach((todo, index) => {
    if (!todo.content) errors.push(`todos[${index}].content must be non-empty`)
    if (!VALID_STATUSES.has(todo.status)) {
      errors.push(`todos[${index}].status must be one of: pending, in_progress, completed`)
    }
    if (!VALID_PRIORITIES.has(todo.priority)) {
      errors.push(`todos[${index}].priority must be one of: high, medium, low`)
    }
  })

  if (errors.length > 0) throw new Error(errors.join('; '))
  return todos
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
    text += `\n${statusIcon(todo.status, theme)} ${content} ${theme.fg('dim', `[${todo.status}, ${todo.priority}]`)}`
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
  pi.registerTool({
    name: 'todowrite',
    label: 'todowrite',
    description: DESCRIPTION,
    promptSnippet: 'Create and update a structured task list for the current coding session',
    promptGuidelines: [
      'Use todowrite to plan and track complex or multi-step work; skip it for single trivial tasks and purely informational requests.',
      'Update todowrite as work progresses: mark one task in_progress when starting it, mark tasks completed immediately, and keep the list current.',
      'When calling todowrite, pass the complete updated todo list, not a partial patch.',
    ],
    parameters: TodoWriteParams,

    async execute(_toolCallId, params) {
      const todos = validateTodos(
        params.todos as Array<Partial<TodoItem> & Record<string, unknown>>,
      )

      // Output is a pure ACP PlanEntry array in JSON — no extra fields, no unsupported statuses.
      return {
        content: [{ type: 'text', text: JSON.stringify(todos, null, 2) }],
        details: { todos },
      }
    },

    renderCall(args, theme) {
      const todos = Array.isArray(args?.todos)
        ? validateTodos(args.todos as Array<Partial<TodoItem> & Record<string, unknown>>)
        : []
      return new Text(
        `${theme.fg('toolTitle', theme.bold('todowrite'))} ${theme.fg('muted', `${todos.length} todo${todos.length === 1 ? '' : 's'}`)}`,
        0,
        0,
      )
    },

    renderResult(result, options, theme) {
      const todos = todosFromResult(result as AgentToolResult<{ todos?: TodoItem[] } | undefined>)
      if (todos) return new Text(formatTodos(todos, theme, options.expanded), 0, 0)
      const text = result.content
        .filter((content) => content.type === 'text')
        .map((content) => content.text || '')
        .join('\n')
      return new Text(text, 0, 0)
    },
  })
}
