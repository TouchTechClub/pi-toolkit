import { describe, expect, test } from 'bun:test'
import {
  formatAnswersContent,
  normalizeQuestion,
  parseMultiSelectInput,
  validateQuestions,
} from '../index.ts'

// These helpers exercise runtime validation, so inputs are intentionally loosely typed
// (the agent receives untrusted tool args at runtime).
type LooseQuestion = Record<string, unknown>
const question = (v: LooseQuestion) => v as Parameters<typeof normalizeQuestion>[0]
const questions = (v: LooseQuestion[]) => v as Parameters<typeof validateQuestions>[0]

describe('normalizeQuestion', () => {
  test('defaults header to Q<index> and custom to true, multiple to false', () => {
    const r = normalizeQuestion(question({ question: 'Pick one?', options: [{ label: 'A' }] }), 0)
    expect(r.header).toBe('Q1')
    expect(r.custom).toBe(true)
    expect(r.multiple).toBe(false)
  })

  test('keeps explicit header/multiple/custom', () => {
    const r = normalizeQuestion(
      question({
        question: 'x',
        header: 'DB',
        options: [{ label: 'A' }],
        multiple: true,
        custom: false,
      }),
      0,
    )
    expect(r.header).toBe('DB')
    expect(r.multiple).toBe(true)
    expect(r.custom).toBe(false)
  })

  test('trims labels and drops empty options', () => {
    const r = normalizeQuestion(
      question({ question: 'x', options: [{ label: '  A  ' }, { label: '   ' }, { label: '' }] }),
      0,
    )
    expect(r.options).toEqual([{ label: 'A', description: undefined }])
  })

  test('trims description and question text', () => {
    const r = normalizeQuestion(
      question({ question: '  hello  ', options: [{ label: 'A', description: '  desc  ' }] }),
      0,
    )
    expect(r.question).toBe('hello')
    expect(r.options[0]?.description).toBe('desc')
  })
})

describe('validateQuestions', () => {
  test('throws when empty', () => {
    expect(() => validateQuestions(questions([]))).toThrow('non-empty')
  })

  test('throws when a question has no options', () => {
    expect(() => validateQuestions(questions([{ question: 'x', options: [] }]))).toThrow(
      'at least one option',
    )
  })

  test('throws when header is longer than 30 chars', () => {
    expect(() =>
      validateQuestions(
        questions([{ question: 'x', options: [{ label: 'A' }], header: 'x'.repeat(31) }]),
      ),
    ).toThrow('30')
  })

  test('throws when question text is empty', () => {
    expect(() =>
      validateQuestions(questions([{ question: '  ', options: [{ label: 'A' }] }])),
    ).toThrow('non-empty')
  })

  test('returns normalized questions', () => {
    const r = validateQuestions(questions([{ question: 'q', options: [{ label: 'A' }] }]))
    expect(r).toHaveLength(1)
    expect(r[0]?.header).toBe('Q1')
  })
})

describe('parseMultiSelectInput', () => {
  test('splits on commas and trims', () => {
    expect(parseMultiSelectInput('SQLite, Postgres ,  Redis ')).toEqual([
      'SQLite',
      'Postgres',
      'Redis',
    ])
  })

  test('drops empty parts', () => {
    expect(parseMultiSelectInput('A,,B,')).toEqual(['A', 'B'])
  })

  test('single value', () => {
    expect(parseMultiSelectInput('A')).toEqual(['A'])
  })
})

describe('formatAnswersContent', () => {
  test('formats opencode-style output with question text', () => {
    const qs = [
      normalizeQuestion(question({ question: 'Which DB?', options: [{ label: 'A' }] }), 0),
      normalizeQuestion(question({ question: 'Language?', options: [{ label: 'B' }] }), 1),
    ]
    const text = formatAnswersContent(qs, [['SQLite'], ['TS', 'Go']])
    expect(text).toContain('User has answered your questions:')
    expect(text).toContain('"Which DB?"="SQLite"')
    expect(text).toContain('"Language?"="TS, Go"')
    expect(text).toContain("You can now continue with the user's answers in mind.")
  })

  test('marks unanswered questions', () => {
    const qs = [
      normalizeQuestion(question({ question: 'Which DB?', options: [{ label: 'A' }] }), 0),
    ]
    expect(formatAnswersContent(qs, [[]])).toContain('"Which DB?"="Unanswered"')
  })
})
