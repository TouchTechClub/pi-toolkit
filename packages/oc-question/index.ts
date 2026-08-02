import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import { Type } from 'typebox'

/**
 * oc-question — unified ask-the-user `question` tool, opencode-inspired.
 *
 * TUI mode renders a rich `ctx.ui.custom()` dialog (tab bar for multiple
 * questions, a final Confirm tab, multi-select toggles, digit shortcuts and an
 * inline editor for custom answers). RPC mode decomposes into
 * `ctx.ui.select()` / `ctx.ui.input()` calls, which emit `extension_ui_request`
 * events that hosts such as S5 Code auto-route to their user-input surface.
 */

// --- Types -----------------------------------------------------------------

interface QuestionOption {
  label: string
  description?: string
}

interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiple: boolean
  custom: boolean
}

interface QuestionDetails {
  questions: Question[]
  answers: string[][]
  cancelled: boolean
}

type DisplayOption = QuestionOption & { isOther?: boolean }

// --- Schema ----------------------------------------------------------------

const QuestionOptionSchema = Type.Object({
  label: Type.String({ description: 'Display label for the option (1-5 words, concise)' }),
  description: Type.Optional(Type.String({ description: 'Optional explanation of the choice' })),
})

const QuestionSchema = Type.Object({
  question: Type.String({ description: 'The full question text to display' }),
  header: Type.String({ description: 'Very short label for tab navigation (max 30 chars)' }),
  options: Type.Array(QuestionOptionSchema, {
    description: 'Available choices; put a recommended option first with "(Recommended)"',
  }),
  multiple: Type.Optional(
    Type.Boolean({ description: 'Allow selecting multiple options (default false)' }),
  ),
  custom: Type.Optional(
    Type.Boolean({
      description: 'Allow a custom "Type your own answer" option (default true)',
    }),
  ),
})

const QuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: 'Questions to ask the user (1 or more)',
  }),
})

const CUSTOM_ANSWER_LABEL = 'Type your own answer'

const QUESTION_DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- When "custom" is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- Answers are returned as arrays of labels, one array per question, in question order; set "multiple": true to allow selecting more than one option
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`

// --- Pure helpers (unit-tested) ---------------------------------------------

export function normalizeQuestion(
  input: Partial<Question> & Record<string, unknown>,
  index: number,
): Question {
  const header = String(input.header ?? '').trim() || `Q${index + 1}`
  const options = Array.isArray(input.options)
    ? (input.options as Array<Partial<QuestionOption> & Record<string, unknown>>)
        .map((o) => ({
          label: String(o.label ?? '').trim(),
          description:
            o.description != null && String(o.description).trim() !== ''
              ? String(o.description).trim()
              : undefined,
        }))
        .filter((o) => o.label.length > 0)
    : []
  return {
    question: String(input.question ?? '').trim(),
    header,
    options,
    multiple: input.multiple === true,
    custom: input.custom !== false,
  }
}

export function validateQuestions(
  input: Array<Partial<Question> & Record<string, unknown>>,
): Question[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('questions must be a non-empty array')
  }
  const normalized = input.map((q, i) => normalizeQuestion(q, i))
  const errors: string[] = []
  normalized.forEach((q, i) => {
    if (!q.question) errors.push(`questions[${i}].question must be non-empty`)
    if (q.header.length > 30) errors.push(`questions[${i}].header must be at most 30 chars`)
    if (q.options.length === 0) {
      errors.push(`questions[${i}].options must contain at least one option`)
    }
  })
  if (errors.length > 0) throw new Error(errors.join('; '))
  return normalized
}

/** Parse a comma-separated multi-select answer back into a list of labels. */
export function parseMultiSelectInput(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** opencode-style summary line for the LLM. */
export function formatAnswersContent(questions: Question[], answers: string[][]): string {
  const formatted = questions
    .map((q, i) => {
      const list = answers[i] ?? []
      const value = list.length > 0 ? list.join(', ') : 'Unanswered'
      return `"${q.question}"="${value}"`
    })
    .join(', ')
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

// --- TUI dialog --------------------------------------------------------------

async function askInTui(ctx: ExtensionContext, questions: Question[]): Promise<string[][] | null> {
  const isSingle = questions.length === 1 && !questions[0].multiple
  const totalTabs = questions.length + 1

  const result = await ctx.ui.custom<{ answers: string[][]; cancelled: boolean } | null>(
    (tui, theme, _kb, done) => {
      let currentTab = 0
      let optionIndex = 0
      let inputMode = false
      let inputQuestionIndex = -1
      let cachedLines: string[] | undefined
      const answers: string[][] = questions.map(() => [])

      const editorTheme: EditorTheme = {
        borderColor: (s) => theme.fg('accent', s),
        selectList: {
          selectedPrefix: (t) => theme.fg('accent', t),
          selectedText: (t) => theme.fg('accent', t),
          description: (t) => theme.fg('muted', t),
          scrollInfo: (t) => theme.fg('dim', t),
          noMatch: (t) => theme.fg('warning', t),
        },
      }
      const editor = new Editor(tui, editorTheme)

      function refresh() {
        cachedLines = undefined
        tui.requestRender()
      }

      function submit(cancelled: boolean) {
        done({ answers: answers.map((a) => [...a]), cancelled })
      }

      function currentQuestion(): Question | undefined {
        return questions[currentTab]
      }

      function currentOptions(): DisplayOption[] {
        const q = currentQuestion()
        if (!q) return []
        const opts: DisplayOption[] = [...q.options]
        if (q.custom) {
          opts.push({ label: CUSTOM_ANSWER_LABEL, isOther: true })
        }
        return opts
      }

      function allAnswered(): boolean {
        return questions.every((_, i) => answers[i].length > 0)
      }

      function advanceAfterAnswer() {
        if (isSingle) {
          submit(false)
          return
        }
        if (currentTab < questions.length - 1) {
          currentTab++
        } else {
          currentTab = questions.length
        }
        optionIndex = 0
        refresh()
      }

      function selectOption(idx: number) {
        const q = currentQuestion()
        const opts = currentOptions()
        const opt = opts[idx]
        if (!q || !opt) return

        if (opt.isOther) {
          inputMode = true
          inputQuestionIndex = currentTab
          editor.setText('')
          refresh()
          return
        }

        if (q.multiple) {
          const list = answers[currentTab]
          const at = list.indexOf(opt.label)
          if (at === -1) list.push(opt.label)
          else list.splice(at, 1)
          refresh()
          return
        }

        answers[currentTab] = [opt.label]
        advanceAfterAnswer()
      }

      editor.onSubmit = (value) => {
        const trimmed = value.trim()
        if (!trimmed) {
          inputMode = false
          inputQuestionIndex = -1
          editor.setText('')
          refresh()
          return
        }
        const i = inputQuestionIndex
        if (i >= 0) {
          const q = questions[i]
          if (q.multiple) {
            const list = answers[i]
            if (!list.includes(trimmed)) list.push(trimmed)
          } else {
            answers[i] = [trimmed]
          }
        }
        inputMode = false
        inputQuestionIndex = -1
        editor.setText('')
        advanceAfterAnswer()
      }

      function handleInput(data: string) {
        if (inputMode) {
          if (matchesKey(data, Key.escape)) {
            inputMode = false
            inputQuestionIndex = -1
            editor.setText('')
            refresh()
            return
          }
          editor.handleInput(data)
          refresh()
          return
        }

        const q = currentQuestion()
        const opts = currentOptions()

        if (!isSingle) {
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
            currentTab = (currentTab + 1) % totalTabs
            optionIndex = 0
            refresh()
            return
          }
          if (matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left)) {
            currentTab = (currentTab - 1 + totalTabs) % totalTabs
            optionIndex = 0
            refresh()
            return
          }
        }

        // Confirm tab: Enter submits when everything is answered, Esc cancels.
        if (currentTab === questions.length) {
          if (matchesKey(data, Key.enter) && allAnswered()) {
            submit(false)
          } else if (matchesKey(data, Key.escape)) {
            submit(true)
          }
          return
        }

        // Digit shortcuts (1-9).
        if (/^[1-9]$/.test(data)) {
          const idx = Number(data) - 1
          if (idx < opts.length) {
            selectOption(idx)
            return
          }
        }

        if (matchesKey(data, Key.up) || data === 'k') {
          optionIndex = Math.max(0, optionIndex - 1)
          refresh()
          return
        }
        if (matchesKey(data, Key.down) || data === 'j') {
          optionIndex = Math.min(opts.length - 1, optionIndex + 1)
          refresh()
          return
        }

        if (matchesKey(data, Key.enter) && q) {
          selectOption(optionIndex)
          return
        }

        if (matchesKey(data, Key.escape)) {
          submit(true)
        }
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines

        const lines: string[] = []
        const renderWidth = Math.max(1, width)
        const q = currentQuestion()
        const opts = currentOptions()

        function addWrapped(text: string) {
          lines.push(...wrapTextWithAnsi(text, renderWidth))
        }

        function addWrappedWithPrefix(prefix: string, text: string) {
          const prefixWidth = visibleWidth(prefix)
          if (prefixWidth >= renderWidth) {
            addWrapped(prefix + text)
            return
          }
          const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth)
          const continuationPrefix = ' '.repeat(prefixWidth)
          for (let i = 0; i < wrapped.length; i++) {
            lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`)
          }
        }

        lines.push(theme.fg('accent', '─'.repeat(renderWidth)))

        // Tab bar for multi-question and multi-select flows.
        if (!isSingle) {
          const tabs: string[] = ['← ']
          for (let i = 0; i < questions.length; i++) {
            const isActive = i === currentTab
            const answered = answers[i].length > 0
            const lbl = questions[i].header
            const mark = answered ? '■' : '□'
            const color = answered ? 'success' : 'muted'
            const text = ` ${mark} ${lbl} `
            const styled = isActive
              ? theme.bg('selectedBg', theme.fg('text', text))
              : theme.fg(color, text)
            tabs.push(`${styled} `)
          }
          const canSubmit = allAnswered()
          const isSubmitTab = currentTab === questions.length
          const submitText = ' ✓ Submit '
          const submitStyled = isSubmitTab
            ? theme.bg('selectedBg', theme.fg('text', submitText))
            : theme.fg(canSubmit ? 'success' : 'dim', submitText)
          tabs.push(`${submitStyled} →`)
          addWrappedWithPrefix(' ', tabs.join(''))
          lines.push('')
        }

        function renderOptions() {
          for (let i = 0; i < opts.length; i++) {
            const opt = opts[i]
            const selected = i === optionIndex
            const isOther = opt.isOther === true
            const prefix = selected ? theme.fg('accent', '> ') : '  '
            let label: string
            if (isOther) {
              label = `${i + 1}. ${opt.label}${inputMode ? ' ✎' : ''}`
            } else if (q?.multiple) {
              const hit = answers[currentTab]?.includes(opt.label)
              label = `${i + 1}. [${hit ? '✓' : ' '}] ${opt.label}`
            } else {
              label = `${i + 1}. ${opt.label}`
            }
            const color = selected || (isOther && inputMode) ? 'accent' : 'text'
            addWrappedWithPrefix(prefix, theme.fg(color, label))
            if (opt.description) {
              addWrappedWithPrefix('     ', theme.fg('muted', opt.description))
            }
          }
        }

        if (inputMode && q) {
          addWrappedWithPrefix(' ', theme.fg('text', q.question))
          lines.push('')
          renderOptions()
          lines.push('')
          addWrappedWithPrefix(' ', theme.fg('muted', 'Your answer:'))
          for (const line of editor.render(Math.max(1, renderWidth - 2))) {
            lines.push(` ${line}`)
          }
          lines.push('')
          addWrappedWithPrefix(' ', theme.fg('dim', 'Enter to submit • Esc to cancel'))
        } else if (currentTab === questions.length) {
          addWrappedWithPrefix(' ', theme.fg('accent', theme.bold('Ready to submit')))
          lines.push('')
          for (let i = 0; i < questions.length; i++) {
            const qq = questions[i]
            const list = answers[i] ?? []
            const value =
              list.length > 0
                ? theme.fg('text', list.join(', '))
                : theme.fg('warning', '(not answered)')
            addWrappedWithPrefix(' ', `${theme.fg('muted', `${qq.header}: `)}${value}`)
          }
          lines.push('')
          if (allAnswered()) {
            addWrappedWithPrefix(' ', theme.fg('success', 'Press Enter to submit'))
          } else {
            const missing = questions
              .filter((_, i) => answers[i].length === 0)
              .map((qq) => qq.header)
              .join(', ')
            addWrappedWithPrefix(' ', theme.fg('warning', `Unanswered: ${missing}`))
          }
        } else if (q) {
          const multipleHint = q.multiple ? ' (select all that apply)' : ''
          addWrappedWithPrefix(' ', theme.fg('text', q.question + multipleHint))
          lines.push('')
          renderOptions()
        }

        lines.push('')
        if (!inputMode) {
          const help = isSingle
            ? '↑↓/jk select • 1-9 pick • Enter confirm • Esc cancel'
            : 'Tab/←→ navigate • ↑↓/jk select • 1-9 pick • Enter confirm • Esc cancel'
          addWrappedWithPrefix(' ', theme.fg('dim', help))
        }
        lines.push(theme.fg('accent', '─'.repeat(renderWidth)))

        cachedLines = lines
        return lines
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined
        },
        handleInput,
      }
    },
  )

  if (!result) return null
  return result.cancelled ? null : result.answers
}

// --- RPC dialog ---------------------------------------------------------------

async function askInRpc(ctx: ExtensionContext, questions: Question[]): Promise<string[][] | null> {
  const answers: string[][] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]

    if (q.multiple) {
      const labels = q.options.map((o) => o.label).join(', ')
      const text = await ctx.ui.input(
        q.header,
        `Select all that apply (comma-separated): ${labels}`,
      )
      if (text === undefined) return null
      answers.push(parseMultiSelectInput(text))
      continue
    }

    const labels = q.options.map((o) => o.label)
    if (q.custom) labels.push(CUSTOM_ANSWER_LABEL)
    const choice = await ctx.ui.select(`${q.header}: ${q.question}`, labels)
    if (choice === undefined) return null

    if (choice === CUSTOM_ANSWER_LABEL) {
      const text = await ctx.ui.input(q.header, 'Type your answer')
      if (text === undefined) return null
      const trimmed = text.trim()
      answers.push(trimmed.length > 0 ? [trimmed] : [])
    } else {
      answers.push([choice])
    }
  }
  return answers
}

// --- Tool ---------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'question',
    label: 'Question',
    description: QUESTION_DESCRIPTION,
    promptSnippet: 'Ask the user questions to clarify requirements or get decisions',
    promptGuidelines: [
      'Use question when you need user input to proceed: gather preferences, clarify ambiguous instructions, or get decisions on implementation choices.',
      'When a question has "custom" enabled (default), a "Type your own answer" option is added automatically; do not add an "Other" or catch-all option yourself.',
      'To recommend an option, make it the first option in the list and add "(Recommended)" at the end of its label.',
      'Set "multiple": true when the user should be able to select more than one option.',
      'Answers come back as arrays of selected labels, one array per question, in question order.',
    ],
    parameters: QuestionParams,
    executionMode: 'sequential',

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: question tool requires an interactive session (TUI or RPC mode).',
            },
          ],
          details: { questions: [], answers: [], cancelled: true },
        }
      }

      const questions = validateQuestions(
        params.questions as Array<Partial<Question> & Record<string, unknown>>,
      )

      const answers =
        ctx.mode === 'tui' ? await askInTui(ctx, questions) : await askInRpc(ctx, questions)
      if (answers === null) {
        return {
          content: [{ type: 'text', text: 'User dismissed the question' }],
          details: { questions, answers: [], cancelled: true },
        }
      }

      return {
        content: [{ type: 'text', text: formatAnswersContent(questions, answers) }],
        details: { questions, answers, cancelled: false },
      }
    },

    renderCall(args, theme) {
      const qs = (args.questions as Question[] | undefined) ?? []
      const count = qs.length
      const labels = qs.map((q) => q.header || q.question).join(', ')
      let text = theme.fg('toolTitle', theme.bold('question '))
      text += theme.fg('muted', `${count} question${count === 1 ? '' : 's'}`)
      if (labels) text += theme.fg('dim', ` (${labels})`)
      return new Text(text, 0, 0)
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionDetails | undefined
      if (!details || details.questions.length === 0) {
        const text = result.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text || '')
          .join('\n')
        return new Text(text, 0, 0)
      }
      if (details.cancelled) {
        return new Text(theme.fg('warning', 'Cancelled'), 0, 0)
      }
      const lines = details.questions.map((q, i) => {
        const list = details.answers[i] ?? []
        if (list.length === 0) {
          return `${theme.fg('warning', '—')} ${theme.fg('muted', q.header)}: ${theme.fg('dim', '(unanswered)')}`
        }
        return `${theme.fg('success', '✓')} ${theme.fg('accent', q.header)}: ${theme.fg('text', list.join(', '))}`
      })
      return new Text(lines.join('\n'), 0, 0)
    },
  })
}
