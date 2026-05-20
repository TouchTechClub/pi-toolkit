import type { PlanEntry, SessionUpdate } from '@agentclientprotocol/sdk'

const TODO_TOOL_NAMES = new Set(['todowrite', 'todo', 'TodoWrite'])

export function todoToolResultToPlanUpdate(
  toolName: string,
  result: unknown,
): SessionUpdate | undefined {
  if (!TODO_TOOL_NAMES.has(toolName)) return undefined

  const todos = extractTodos(result)
  if (!todos) return undefined

  const entries = todos.map(todoToPlanEntry).filter((e): e is PlanEntry => e !== undefined)
  if (!entries.length) return undefined

  return { sessionUpdate: 'plan', entries }
}

function extractTodos(result: unknown): unknown[] | undefined {
  // Prefer details.todos (Pi extension convention).
  const details = (result as Record<string, unknown> | null | undefined)?.details as
    | Record<string, unknown>
    | null
    | undefined
  const detailTodos = details?.todos
  if (Array.isArray(detailTodos)) return detailTodos

  // Fallback: parse JSON array from first text content block.
  const content = (result as Record<string, unknown> | null | undefined)?.content
  if (!Array.isArray(content)) return undefined

  for (const block of content) {
    const b = block as Record<string, unknown> | null | undefined
    if (b?.type !== 'text' || typeof b.text !== 'string' || !b.text.trim()) continue

    try {
      const parsed = JSON.parse(b.text)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Not JSON todo output; ignore.
    }
  }

  return undefined
}

function todoToPlanEntry(todo: unknown): PlanEntry | undefined {
  if (!todo || typeof todo !== 'object') return undefined
  const record = todo as Record<string, unknown>

  // The todowrite extension already outputs valid ACP PlanEntry shapes:
  //   { content: string, status: "pending"|"in_progress"|"completed", priority: "high"|"medium"|"low" }
  if (typeof record.content !== 'string' || !record.content.trim()) return undefined

  return {
    content: record.content,
    priority: (typeof record.priority === 'string'
      ? record.priority
      : 'medium') as PlanEntry['priority'],
    status: (typeof record.status === 'string' ? record.status : 'pending') as PlanEntry['status'],
  }
}
