// @pi-acp-compatible

import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'

const EXT = 'checkpoint-undo-redo'
const GIT_TIMEOUT = 30_000

type Checkpoint = {
  userEntryId: string
  beforeLeafId: string | null
  finalLeafId: string
  prompt: string
  beforeSnapshot: string
  afterSnapshot: string
  files: string[]
  createdAt: number
}

type ActiveCheckpoint = Omit<Checkpoint, 'finalLeafId' | 'afterSnapshot' | 'files' | 'createdAt'>

export default function checkpointUndoRedo(pi: ExtensionAPI) {
  const checkpoints = new Map<string, Checkpoint>()
  const redoStack: Checkpoint[] = []
  let active: ActiveCheckpoint | undefined
  let pendingPrompt: string | undefined
  let snapshotter: ShadowGit | undefined

  pi.on('session_start', (_event, ctx) => {
    snapshotter = new ShadowGit(pi, ctx.cwd, ctx.sessionManager.getSessionId())
    checkpoints.clear()
    redoStack.length = 0
    active = undefined

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== 'custom' || entry.customType !== EXT) continue
      const data = entry.data as Partial<Checkpoint> | undefined
      const checkpoint = repairCheckpoint(data, ctx.sessionManager)
      if (checkpoint) checkpoints.set(checkpoint.userEntryId, checkpoint)
    }
  })

  pi.on('before_agent_start', (event) => {
    // A new real user prompt commits the current branch, so redo history is no longer valid.
    redoStack.length = 0
    active = undefined
    pendingPrompt = event.prompt
  })

  pi.on('message_start', async (event, ctx) => {
    // The user message is not in SessionManager during before_agent_start.
    // By the first assistant message it has been persisted, but tools have not
    // executed yet, so this is the right time to bind the checkpoint to the
    // current user entry and capture the pre-edit file state.
    if (event.message.role !== 'assistant' || active || pendingPrompt === undefined) return

    const branch = ctx.sessionManager.getBranch()
    const userEntry = findLatestUserByText(branch, pendingPrompt)
    if (!userEntry) return

    try {
      const beforeSnapshot = await getSnapshotter(ctx).track()
      active = {
        userEntryId: userEntry.id,
        beforeLeafId: userEntry.parentId,
        prompt: userText(userEntry.message),
        beforeSnapshot,
      }
    } catch (error) {
      active = undefined
      ctx.ui.notify(`Checkpoint skipped: ${message(error)}`, 'warning')
    }
  })

  pi.on('agent_end', async (_event, ctx) => {
    if (!active) return
    const current = active
    active = undefined

    try {
      const snap = getSnapshotter(ctx)
      const afterSnapshot = await snap.track()
      const files = await snap.diffFiles(current.beforeSnapshot, afterSnapshot)
      const checkpoint: Checkpoint = {
        ...current,
        finalLeafId: ctx.sessionManager.getLeafId() ?? current.userEntryId,
        afterSnapshot,
        files,
        createdAt: Date.now(),
      }
      checkpoints.set(checkpoint.userEntryId, checkpoint)
      pi.appendEntry(EXT, checkpoint)
    } catch (error) {
      ctx.ui.notify(`Checkpoint finalization failed: ${message(error)}`, 'warning')
    } finally {
      pendingPrompt = undefined
    }
  })

  registerUndoCommand('undo', 'Undo last user message and restore its file checkpoint')
  registerRedoCommand('redo', 'Redo the most recently undone message and file checkpoint')

  // ACP clients usually build their command palettes from the agent's advertised
  // command list. Keep explicit ACP aliases so integrations can invoke these
  // without colliding with a client's own built-in undo/redo actions.
  registerUndoCommand('acp-undo', 'ACP-safe alias for /undo')
  registerRedoCommand('acp-redo', 'ACP-safe alias for /redo')
  registerUndoCommand('checkpoint-undo', 'Alias for /undo')
  registerRedoCommand('checkpoint-redo', 'Alias for /redo')

  pi.registerCommand('diff', {
    description: 'Show diff stats (lines added/removed) for each file changed in current session',
    handler: async (_args, ctx) => diff(ctx),
  })

  function registerUndoCommand(name: string, description: string) {
    pi.registerCommand(name, {
      description,
      handler: async (_args, ctx) => undo(ctx),
    })
  }

  function registerRedoCommand(name: string, description: string) {
    pi.registerCommand(name, {
      description,
      handler: async (_args, ctx) => redo(ctx),
    })
  }

  async function undo(ctx: ExtensionCommandContext) {
    await ctx.waitForIdle()
    const branch = ctx.sessionManager.getBranch()
    const target = [...branch]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'message' && entry.message.role === 'user' && checkpoints.has(entry.id),
      )

    if (!target || target.type !== 'message') {
      ctx.ui.notify('No checkpointed user message to undo', 'warning')
      return
    }

    const checkpoint = checkpoints.get(target.id)!
    if (!checkpoint.beforeLeafId) {
      ctx.ui.notify(
        'Cannot undo the first session message in-place; use /fork before it instead.',
        'warning',
      )
      return
    }

    try {
      await getSnapshotter(ctx).restoreFiles(checkpoint.beforeSnapshot, checkpoint.files)
      const result = await ctx.navigateTree(checkpoint.beforeLeafId, { summarize: false })
      if (result.cancelled) return
      redoStack.push(checkpoint)
      ctx.ui.setEditorText(checkpoint.prompt)
      ctx.ui.notify(`Undid message; restored ${checkpoint.files.length} file(s)`, 'info')
    } catch (error) {
      ctx.ui.notify(`Undo failed: ${message(error)}`, 'error')
    }
  }

  async function redo(ctx: ExtensionCommandContext) {
    await ctx.waitForIdle()
    const checkpoint = redoStack.pop()
    if (!checkpoint) {
      ctx.ui.notify('Nothing to redo', 'warning')
      return
    }

    try {
      await getSnapshotter(ctx).restoreFiles(checkpoint.afterSnapshot, checkpoint.files)
      const result = await ctx.navigateTree(checkpoint.finalLeafId, { summarize: false })
      if (result.cancelled) {
        redoStack.push(checkpoint)
        return
      }
      ctx.ui.setEditorText('')
      ctx.ui.notify(`Redid message; restored ${checkpoint.files.length} file(s)`, 'info')
    } catch (error) {
      redoStack.push(checkpoint)
      ctx.ui.notify(`Redo failed: ${message(error)}`, 'error')
    }
  }

  async function diff(ctx: ExtensionCommandContext) {
    await ctx.waitForIdle()

    if (checkpoints.size === 0) {
      ctx.ui.notify('No checkpoints in current session', 'info')
      return
    }

    const snap = getSnapshotter(ctx)
    const aggregated = new Map<string, { added: number; removed: number }>()

    for (const checkpoint of checkpoints.values()) {
      try {
        const stats = await snap.diffNumstat(checkpoint.beforeSnapshot, checkpoint.afterSnapshot)
        for (const [file, { added, removed }] of stats) {
          const existing = aggregated.get(file)
          if (existing) {
            existing.added += added
            existing.removed += removed
          } else {
            aggregated.set(file, { added, removed })
          }
        }
      } catch (error) {
        ctx.ui.notify(`Skipping checkpoint: ${message(error)}`, 'warning')
      }
    }

    if (aggregated.size === 0) {
      ctx.ui.notify('No file changes across checkpoints', 'info')
      return
    }

    // Sort by total changes descending
    const sorted = [...aggregated.entries()].sort(
      (a, b) => b[1].added + b[1].removed - (a[1].added + a[1].removed),
    )

    const t = ctx.ui.theme
    let totalAdded = 0
    let totalRemoved = 0

    let output = `${t.bold('Session Diff')}\n\n`

    for (const [file, { added, removed }] of sorted) {
      totalAdded += added
      totalRemoved += removed
      output += `${t.fg('text', file)}  ${t.fg('toolDiffAdded', `+${added}`)}/${t.fg('toolDiffRemoved', `-${removed}`)}\n`
    }

    output += `\n${t.fg('dim', 'Total')}\n`
    output += `${t.fg('toolDiffAdded', `+${totalAdded}`)}/${t.fg('toolDiffRemoved', `-${totalRemoved}`)} across ${t.bold(String(sorted.length))} file(s)`

    ctx.ui.notify(output, 'info')
  }

  function getSnapshotter(ctx: { cwd: string; sessionManager: { getSessionId(): string } }) {
    if (!snapshotter) snapshotter = new ShadowGit(pi, ctx.cwd, ctx.sessionManager.getSessionId())
    return snapshotter
  }
}

class ShadowGit {
  private initialized = false
  private readonly gitdir: string

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly cwd: string,
    sessionId: string,
  ) {
    const key = createHash('sha256').update(`${cwd}\0${sessionId}`).digest('hex').slice(0, 24)
    this.gitdir = path.join(homedir(), '.pi', 'agent', 'checkpoints', key)
  }

  async track(): Promise<string> {
    await this.ensure()
    await this.addAll()
    const result = await this.git(['write-tree'])
    return result.stdout.trim()
  }

  async diffFiles(from: string, to: string): Promise<string[]> {
    await this.ensure()
    const result = await this.git(['diff', '--name-only', '--no-renames', from, to, '--', '.'])
    return unique(
      result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    )
  }

  async diffNumstat(
    from: string,
    to: string,
  ): Promise<Map<string, { added: number; removed: number }>> {
    await this.ensure()
    const result = await this.git(['diff', '--numstat', '--no-renames', from, to, '--', '.'])
    const stats = new Map<string, { added: number; removed: number }>()
    for (const line of result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)) {
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const added = Number.parseInt(parts[0], 10)
      const removed = Number.parseInt(parts[1], 10)
      if (Number.isNaN(added) || Number.isNaN(removed)) continue
      stats.set(parts[2], { added, removed })
    }
    return stats
  }

  async restoreFiles(snapshot: string, files: string[]): Promise<void> {
    await this.ensure()
    for (const file of files) {
      const rel = normalizeGitPath(file)
      if (!rel) continue
      const exists = await this.git(['ls-tree', snapshot, '--', rel], { allowFailure: true })
      if (exists.code === 0 && exists.stdout.trim()) {
        await this.git(['checkout', snapshot, '--', rel])
      } else {
        await rm(path.join(this.cwd, rel), { recursive: true, force: true })
      }
    }
    await this.addAll()
  }

  private async ensure(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.gitdir, { recursive: true })
    await this.git(['init'])
    await this.git(['config', 'core.autocrlf', 'false'])
    await this.git(['config', 'core.longpaths', 'true'])
    await this.git(['config', 'core.symlinks', 'true'])
    await this.git(['config', 'core.fsmonitor', 'false'])
    this.initialized = true
  }

  private async addAll(): Promise<void> {
    await this.git(['add', '--all', '--', '.', ':(exclude).pi'])
  }

  private async git(args: string[], opts: { allowFailure?: boolean } = {}) {
    const result = await this.pi.exec(
      'git',
      ['--git-dir', this.gitdir, '--work-tree', this.cwd, ...args],
      {
        cwd: this.cwd,
        timeout: GIT_TIMEOUT,
      },
    )
    if (!opts.allowFailure && result.code !== 0) {
      throw new Error(result.stderr.trim() || `git ${args.join(' ')} exited ${result.code}`)
    }
    return result
  }
}

function latestUserEntry(branch: SessionEntry[]) {
  return [...branch]
    .reverse()
    .find((entry) => entry.type === 'message' && entry.message.role === 'user') as
    | UserMessageEntry
    | undefined
}

function findLatestUserByText(branch: SessionEntry[], text: string) {
  return [...branch]
    .reverse()
    .find(
      (entry) =>
        entry.type === 'message' &&
        entry.message.role === 'user' &&
        userText(entry.message) === text,
    ) as UserMessageEntry | undefined
}

type UserMessageEntry = Extract<SessionEntry, { type: 'message' }> & { message: { role: 'user' } }

type ReadonlySessionLookup = {
  getEntry(id: string): SessionEntry | undefined
  getBranch(fromId?: string): SessionEntry[]
}

function repairCheckpoint(value: Partial<Checkpoint> | undefined, sessions: ReadonlySessionLookup) {
  if (!isCheckpoint(value)) return

  const original = sessions.getEntry(value.userEntryId)
  if (
    original?.type === 'message' &&
    original.message.role === 'user' &&
    userText(original.message) === value.prompt
  ) {
    return value
  }

  // Older versions captured before the new user message was persisted, so a
  // checkpoint could be stored under the previous user id. Recover those by
  // finding the prompt on the path to the recorded final leaf.
  const repairedUser = findLatestUserByText(sessions.getBranch(value.finalLeafId), value.prompt)
  if (!repairedUser) return
  return {
    ...value,
    userEntryId: repairedUser.id,
    beforeLeafId: repairedUser.parentId,
  } satisfies Checkpoint
}

function userText(message: { content: unknown }) {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'),
    )
    .map((block) => block.text)
    .join('')
}

function isCheckpoint(value: Partial<Checkpoint> | undefined): value is Checkpoint {
  return Boolean(
    value &&
      typeof value.userEntryId === 'string' &&
      typeof value.finalLeafId === 'string' &&
      typeof value.beforeSnapshot === 'string' &&
      typeof value.afterSnapshot === 'string' &&
      Array.isArray(value.files),
  )
}

function normalizeGitPath(file: string): string | undefined {
  if (!file || path.isAbsolute(file) || file.includes('\0')) return
  const normalized = file.replaceAll('\\', '/')
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return
  return normalized
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
