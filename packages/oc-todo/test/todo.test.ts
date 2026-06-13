import { describe, expect, test } from 'bun:test'
import {
  formatTodoStatus,
  formatTodosForRead,
  normalizeTodo,
  openTodos,
  validateTodos,
} from '../index.ts'

// These helpers exercise runtime validation, so inputs are intentionally loosely typed
// (the agent receives untrusted tool args at runtime).
type LooseTodo = Record<string, unknown>
const todo = (v: LooseTodo) => v as Parameters<typeof normalizeTodo>[0]
const todos = (v: LooseTodo[]) => v as Parameters<typeof validateTodos>[0]

describe('normalizeTodo', () => {
  test('lowercases and trims status/priority', () => {
    const r = normalizeTodo(
      todo({ content: '  do it  ', status: ' IN_PROGRESS ', priority: ' HIGH ' }),
    )
    expect(r.content).toBe('do it')
    expect(r.status).toBe('in_progress')
    expect(r.priority).toBe('high')
  })

  test('defaults missing status/priority', () => {
    const r = normalizeTodo(todo({ content: 'x' }))
    expect(r.status).toBe('pending')
    expect(r.priority).toBe('medium')
  })

  test('keeps positive integer ids, drops invalid ones', () => {
    expect(normalizeTodo(todo({ content: 'x', id: 4.7 })).id).toBe(4)
    expect(normalizeTodo(todo({ content: 'x', id: 0 })).id).toBeUndefined()
    expect(normalizeTodo(todo({ content: 'x', id: -3 })).id).toBeUndefined()
    expect(normalizeTodo(todo({ content: 'x', id: Number.NaN })).id).toBeUndefined()
  })
})

describe('validateTodos', () => {
  test('auto-assigns sequential ids when omitted', () => {
    const r = validateTodos(
      todos([
        { content: 'a', status: 'pending', priority: 'low' },
        { content: 'b', status: 'pending', priority: 'low' },
      ]),
    )
    expect(r.map((t) => t.id)).toEqual([1, 2])
  })

  test('respects explicit ids and continues after the max', () => {
    const r = validateTodos(
      todos([
        { content: 'a', status: 'pending', priority: 'low', id: 5 },
        { content: 'b', status: 'pending', priority: 'low' },
      ]),
    )
    expect(r[0].id).toBe(5)
    expect(r[1].id).toBe(6)
  })

  test('throws on empty content', () => {
    expect(() =>
      validateTodos(todos([{ content: '   ', status: 'pending', priority: 'low' }])),
    ).toThrow(/content must be non-empty/)
  })

  test('throws on invalid status', () => {
    expect(() => validateTodos(todos([{ content: 'a', status: 'done', priority: 'low' }]))).toThrow(
      /status must be one of/,
    )
  })

  test('throws on invalid priority', () => {
    expect(() =>
      validateTodos(todos([{ content: 'a', status: 'pending', priority: 'urgent' }])),
    ).toThrow(/priority must be one of/)
  })
})

const item = (id: number, status: string, content = `t${id}`) =>
  ({ id, content, status, priority: 'medium' }) as ReturnType<typeof validateTodos>[number]

describe('openTodos', () => {
  test('filters out completed todos, preserving order', () => {
    const list = [item(1, 'pending'), item(2, 'completed'), item(3, 'in_progress')]
    expect(openTodos(list).map((t) => t.id)).toEqual([1, 3])
  })
})

describe('formatTodoStatus', () => {
  test('undefined for an empty list', () => {
    expect(formatTodoStatus([])).toBeUndefined()
  })

  test('shows completed/total with an in-progress icon', () => {
    const out = formatTodoStatus([item(1, 'in_progress'), item(2, 'completed')])
    expect(out).toContain('1/2')
    expect(out).toContain('◐')
  })

  test('uses the done icon when everything is completed', () => {
    expect(formatTodoStatus([item(1, 'completed')])).toContain('✓')
  })
})

describe('formatTodosForRead', () => {
  test('undefined when empty', () => {
    expect(formatTodosForRead([])).toBeUndefined()
  })

  test('lists every todo with status markers and a remaining count', () => {
    const out = formatTodosForRead([
      item(1, 'completed', 'done thing'),
      item(2, 'in_progress', 'doing thing'),
      item(3, 'pending', 'todo thing'),
    ])
    expect(out).toContain('[CURRENT TODO LIST]')
    expect(out).toContain('2 of 3 task(s) remaining.')
    expect(out).toContain('[x] (1) done thing [medium]')
    expect(out).toContain('[~] (2) doing thing [medium]')
    expect(out).toContain('[ ] (3) todo thing [medium]')
  })

  test('still returns output when all todos are completed', () => {
    const out = formatTodosForRead([item(1, 'completed', 'done thing')])
    expect(out).toContain('[CURRENT TODO LIST]')
    expect(out).toContain('0 of 1 task(s) remaining.')
    expect(out).toContain('[x] (1) done thing')
  })
})
