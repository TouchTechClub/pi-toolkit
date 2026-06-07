// @pi-acp-compatible

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'

const EXT = 'checkpoint-undo-redo'
const GIT_TIMEOUT = 30_000
const CHECKPOINTS_DIR = path.join(homedir(), '.pi', 'agent', 'checkpoints')
const META_FILE = 'pi-checkpoint-meta.json'

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
  // Files changed by checkpoints on the active branch — i.e. exactly what `/diff`
  // (with no arg) would list. Cached so `/diff` argument completion can offer
  // them without access to the session in getArgumentCompletions().
  let branchFiles: string[] = []

  function refreshBranchFiles(ctx: { sessionManager: { getBranch(): SessionEntry[] } }) {
    branchFiles = collectBranchDiffFiles(ctx.sessionManager.getBranch(), checkpoints)
  }

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
    refreshBranchFiles(ctx)
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
      refreshBranchFiles(ctx)
    } catch (error) {
      ctx.ui.notify(`Checkpoint finalization failed: ${message(error)}`, 'warning')
    } finally {
      pendingPrompt = undefined
    }
  })

  registerUndoCommand('undo', 'Undo last user message and restore its file checkpoint')
  registerRedoCommand('redo', 'Redo the most recently undone message and file checkpoint')

  pi.registerCommand('diff', {
    description:
      'Show session diff. With no args: per-file line stats. With a file path: full unified diff for that file.',
    getArgumentCompletions: (prefix) => diffFileCompletions(branchFiles, prefix),
    handler: async (args, ctx) => diff(ctx, args.trim()),
  })

  pi.registerCommand('checkpoints', {
    description:
      'Show disk usage of checkpoint snapshots across sessions and optionally delete them',
    handler: async (_args, ctx) => manageCheckpointCache(ctx),
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
      refreshBranchFiles(ctx)
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
      refreshBranchFiles(ctx)
      ctx.ui.notify(`Redid message; restored ${checkpoint.files.length} file(s)`, 'info')
    } catch (error) {
      redoStack.push(checkpoint)
      ctx.ui.notify(`Redo failed: ${message(error)}`, 'error')
    }
  }

  async function diff(ctx: ExtensionCommandContext, file = '') {
    await ctx.waitForIdle()

    if (checkpoints.size === 0) {
      ctx.ui.notify('No checkpoints in current session', 'info')
      return
    }

    // Only include checkpoints on the current active branch path
    const branchUserIds = new Set(
      ctx.sessionManager
        .getBranch()
        .filter((e) => e.type === 'message' && e.message.role === 'user')
        .map((e) => e.id),
    )

    if (file) {
      await diffFile(ctx, branchUserIds, file)
      return
    }

    const snap = getSnapshotter(ctx)
    const aggregated = new Map<string, { added: number; removed: number }>()

    for (const checkpoint of checkpoints.values()) {
      if (!branchUserIds.has(checkpoint.userEntryId)) continue
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

  async function diffFile(ctx: ExtensionCommandContext, branchUserIds: Set<string>, file: string) {
    const rel = normalizeGitPath(file)
    if (!rel) {
      ctx.ui.notify(`Invalid file path: ${file}`, 'warning')
      return
    }

    // Walk the branch in order to find the first "before" and last "after"
    // snapshot that bracket all edits to this file on the active branch.
    let from: string | undefined
    let to: string | undefined
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'message' || entry.message.role !== 'user') continue
      if (!branchUserIds.has(entry.id)) continue
      const checkpoint = checkpoints.get(entry.id)
      if (!checkpoint || !checkpoint.files.includes(rel)) continue
      if (from === undefined) from = checkpoint.beforeSnapshot
      to = checkpoint.afterSnapshot
    }

    if (from === undefined || to === undefined) {
      ctx.ui.notify(`No checkpointed changes to ${rel} in current session`, 'info')
      return
    }

    let raw: string
    try {
      raw = await getSnapshotter(ctx).diffFile(from, to, rel)
    } catch (error) {
      ctx.ui.notify(`Diff failed: ${message(error)}`, 'error')
      return
    }

    if (!raw.trim()) {
      ctx.ui.notify(`No net changes to ${rel} (edits cancelled out)`, 'info')
      return
    }

    const t = ctx.ui.theme
    const header = `${t.bold('Diff')} ${t.fg('text', rel)}\n\n`
    ctx.ui.notify(header + colorizeDiff(raw, t), 'info')
  }

  function getSnapshotter(ctx: { cwd: string; sessionManager: { getSessionId(): string } }) {
    if (!snapshotter) snapshotter = new ShadowGit(pi, ctx.cwd, ctx.sessionManager.getSessionId())
    return snapshotter
  }
}

async function manageCheckpointCache(ctx: ExtensionCommandContext) {
  if (!ctx.hasUI) return

  ctx.ui.setStatus('checkpoint', 'Listing checkpoint snapshots…')
  const currentKey = checkpointKey(ctx.cwd, ctx.sessionManager.getSessionId())
  const stores = await listCheckpointStores(currentKey)
  ctx.ui.setStatus('checkpoint', undefined)
  if (stores.length === 0) {
    ctx.ui.notify('No checkpoint snapshots found.', 'info')
    return
  }

  ctx.ui.notify(`${summarizeByProject(stores)}\n\n${summarizeUsage(stores, 'session')}`, 'info')

  const DELETE_OLD = 'Delete snapshots older than N days…'
  const DELETE_OTHERS = 'Delete all EXCEPT current session'
  const DELETE_ALL = 'Delete ALL checkpoint snapshots'
  const CANCEL = 'Cancel'
  const hasOthers = stores.some((s) => !s.current)
  const options = hasOthers
    ? [DELETE_OLD, DELETE_OTHERS, DELETE_ALL, CANCEL]
    : [DELETE_OLD, DELETE_ALL, CANCEL]
  const choice = await ctx.ui.select('Checkpoint snapshots', options)
  if (!choice || choice === CANCEL) return

  // Deleting the current session's store mid-session would desync the in-memory
  // checkpoint state, so the current store is only ever removed by DELETE_ALL,
  // which is explicitly confirmed.
  let targets: CacheEntry[]
  let warning: string

  if (choice === DELETE_OLD) {
    const answer = await ctx.ui.input('Delete snapshots older than how many days?', '7')
    if (answer === undefined) return
    const days = Number.parseFloat(answer.trim())
    if (!Number.isFinite(days) || days < 0) {
      ctx.ui.notify('Please enter a non-negative number of days.', 'warning')
      return
    }
    // Never delete the current session's store by age.
    targets = filterOlderThan(
      stores.filter((s) => !s.current),
      days,
      Date.now(),
    )
    if (targets.length === 0) {
      ctx.ui.notify(`No snapshots older than ${days} day(s) (current session excluded).`, 'info')
      return
    }
    const freedTotal = targets.reduce((sum, s) => sum + s.bytes, 0)
    warning = `This permanently removes ${targets.length} snapshot store(s) older than ${days} day(s), freeing ${formatBytes(freedTotal)}. The current session is kept.`
  } else {
    targets = choice === DELETE_OTHERS ? stores.filter((s) => !s.current) : stores
    const freedTotal = targets.reduce((sum, s) => sum + s.bytes, 0)
    warning =
      choice === DELETE_ALL
        ? `This permanently removes ${targets.length} snapshot store(s) freeing ${formatBytes(freedTotal)}, including the current session. Undo/redo history for those sessions will be lost.`
        : `This permanently removes ${targets.length} snapshot store(s) freeing ${formatBytes(freedTotal)}. The current session is kept.`
  }

  const ok = await ctx.ui.confirm('Delete checkpoint snapshots?', warning)
  if (!ok) return

  let freed = 0
  ctx.ui.setStatus('checkpoint', `Deleting ${targets.length} snapshot store(s)…`)
  for (const store of targets) {
    await rm(store.path, { recursive: true, force: true }).catch(() => {})
    freed += store.bytes
  }
  ctx.ui.setStatus('checkpoint', undefined)
  ctx.ui.notify(`Deleted ${targets.length} snapshot store(s); freed ${formatBytes(freed)}.`, 'info')
}

class ShadowGit {
  private initialized = false
  private readonly gitdir: string

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly cwd: string,
    private readonly sessionId: string,
  ) {
    const key = createHash('sha256').update(`${cwd}\0${sessionId}`).digest('hex').slice(0, 24)
    this.gitdir = path.join(CHECKPOINTS_DIR, key)
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

  async diffFile(from: string, to: string, file: string): Promise<string> {
    await this.ensure()
    const result = await this.git(['diff', '--no-color', '--no-renames', from, to, '--', file])
    return result.stdout
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
    // Record which project/session this store belongs to so cleanup can label
    // it. Best-effort: the hashed dir name is otherwise opaque.
    await writeFile(
      path.join(this.gitdir, META_FILE),
      JSON.stringify({ cwd: this.cwd, sessionId: this.sessionId, updatedAt: Date.now() }),
    ).catch(() => {})
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

export function userText(message: { content: unknown }) {
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

export function normalizeGitPath(file: string): string | undefined {
  if (!file || path.isAbsolute(file) || file.includes('\0')) return
  const normalized = file.replaceAll('\\', '/')
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return
  // Snapshots exclude the `.pi` directory (see ShadowGit.addAll), so restores must never
  // touch it either. Guard here to keep the snapshot/restore invariant explicit rather
  // than relying on `.pi` files never being tracked.
  if (normalized === '.pi' || normalized.startsWith('.pi/')) return
  return normalized
}

function unique(values: string[]) {
  return [...new Set(values)]
}

type ThemeLike = ExtensionCommandContext['ui']['theme']

// Structural shape of pi-tui's AutocompleteItem. Defined locally so the
// extension does not need a direct pi-tui dependency just for this type.
type CompletionItem = { value: string; label: string; description?: string }

/**
 * Unique list of files changed by checkpoints on the active branch path —
 * exactly the files `/diff` (no arg) reports. Pure for unit testing.
 */
export function collectBranchDiffFiles(
  branch: SessionEntry[],
  checkpoints: Map<string, Checkpoint>,
): string[] {
  const branchUserIds = new Set(
    branch.filter((e) => e.type === 'message' && e.message.role === 'user').map((e) => e.id),
  )
  const files = new Set<string>()
  for (const id of branchUserIds) {
    const checkpoint = checkpoints.get(id)
    if (!checkpoint) continue
    for (const file of checkpoint.files) files.add(file)
  }
  return [...files].sort()
}

/**
 * Argument completions for `/diff <file>`: only files that actually have
 * checkpointed changes on the active branch, filtered by the typed prefix.
 * Pure so it can be unit-tested.
 */
export function diffFileCompletions(files: string[], prefix: string): CompletionItem[] {
  const trimmed = prefix.trimStart().toLowerCase()
  return files
    .filter((file) => file.toLowerCase().includes(trimmed))
    .map((file) => ({ value: file, label: file, description: 'changed in this session' }))
}

// Colorize a unified diff for terminal display: additions green, deletions red,
// hunk headers dimmed. Pure string transform so it can be unit-tested.
export function colorizeDiff(diff: string, theme: ThemeLike): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return theme.fg('dim', line)
      if (line.startsWith('@@')) return theme.fg('dim', line)
      if (line.startsWith('+')) return theme.fg('toolDiffAdded', line)
      if (line.startsWith('-')) return theme.fg('toolDiffRemoved', line)
      return theme.fg('text', line)
    })
    .join('\n')
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Cache usage / cleanup
// ---------------------------------------------------------------------------

export interface CacheEntry {
  /** Human-readable label. */
  label: string
  /** Absolute path to the checkpoint store. */
  path: string
  /** Total size in bytes. */
  bytes: number
  /** True for the store backing the current session. */
  current: boolean
  /** Project working directory this store belongs to, if known. */
  cwd?: string
  /** Epoch ms the store was last updated (from meta, falling back to dir mtime). */
  updatedAt?: number
}

/** Replace a leading home directory with `~` for compact display. Pure. */
export function tildify(p: string, home = homedir()): string {
  if (home && (p === home || p.startsWith(`${home}/`))) {
    return `~${p.slice(home.length)}`
  }
  return p
}

/**
 * Human-readable age string, e.g. "just now", "3h ago", "2d ago".
 * Pure so it can be unit-tested with a fixed `now`.
 */
export function age(ts: number | undefined, now: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '?'
  const ms = now - ts
  if (ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  const yr = Math.floor(mo / 12)
  return `${yr}y ago`
}

/** Stable hashed directory name for a (cwd, sessionId) checkpoint store. */
export function checkpointKey(cwd: string, sessionId: string): string {
  return createHash('sha256').update(`${cwd}\0${sessionId}`).digest('hex').slice(0, 24)
}

/** Format a byte count as a short human-readable string (e.g. "1.4 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exp
  const formatted = exp === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1)
  return `${formatted} ${units[exp]}`
}

/**
 * Render a usage summary: each entry largest-first, plus a total line.
 * Pure (no theme, no I/O) so it can be unit-tested.
 */
export function summarizeUsage(entries: CacheEntry[], noun = 'item', plural = `${noun}s`): string {
  if (entries.length === 0) return `No cached ${plural} found.`
  const sorted = [...entries].sort((a, b) => b.bytes - a.bytes)
  const total = sorted.reduce((sum, e) => sum + e.bytes, 0)
  const width = Math.max(...sorted.map((e) => formatBytes(e.bytes).length))
  const lines = sorted.map(
    (e) => `  ${formatBytes(e.bytes).padStart(width)}  ${e.label}${e.current ? ' (current)' : ''}`,
  )
  const count = `${sorted.length} ${sorted.length === 1 ? noun : plural}`
  return [...lines, '', `  ${formatBytes(total).padStart(width)}  total across ${count}`].join('\n')
}

/**
 * Aggregate checkpoint stores by project (cwd) and render size per project,
 * largest-first, plus a grand total. Stores with no known cwd are grouped
 * under "(unknown project)". Pure for unit testing.
 */
export function summarizeByProject(entries: CacheEntry[]): string {
  if (entries.length === 0) return 'No checkpoint snapshots found.'
  const byProject = new Map<string, { bytes: number; sessions: number }>()
  for (const entry of entries) {
    const key = entry.cwd ? tildify(entry.cwd) : '(unknown project)'
    const agg = byProject.get(key) ?? { bytes: 0, sessions: 0 }
    agg.bytes += entry.bytes
    agg.sessions += 1
    byProject.set(key, agg)
  }
  const rows = [...byProject.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
  const total = rows.reduce((sum, [, agg]) => sum + agg.bytes, 0)
  const width = Math.max(...rows.map(([, agg]) => formatBytes(agg.bytes).length))
  const lines = rows.map(
    ([project, agg]) =>
      `  ${formatBytes(agg.bytes).padStart(width)}  ${project} (${agg.sessions} session${agg.sessions === 1 ? '' : 's'})`,
  )
  return [
    ...lines,
    '',
    `  ${formatBytes(total).padStart(width)}  total across ${rows.length} project${rows.length === 1 ? '' : 's'}`,
  ].join('\n')
}

/**
 * Stores last updated strictly more than `days` days before `now`. Entries with
 * an unknown timestamp are excluded (never deleted by age). Pure for testing.
 */
export function filterOlderThan(entries: CacheEntry[], days: number, now: number): CacheEntry[] {
  if (!Number.isFinite(days) || days < 0) return []
  const cutoff = now - days * 24 * 60 * 60 * 1000
  return entries.filter((e) => typeof e.updatedAt === 'number' && e.updatedAt < cutoff)
}

/**
 * Extract `core.worktree` from a git config file's text — the project path the
 * shadow git was bound to via `--work-tree`. This is recorded by git for every
 * store, so it recovers the project even for stores created before meta.json.
 * Pure for unit testing.
 */
export function parseGitWorktree(config: string): string | undefined {
  const match = config.match(/^\s*worktree\s*=\s*(.+?)\s*$/m)
  return match ? match[1] : undefined
}

/** Recursively sum the size of all regular files under a directory. */
async function measureDir(dir: string): Promise<number> {
  let total = 0
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await measureDir(full)
    } else if (entry.isFile()) {
      total += await stat(full)
        .then((s) => s.size)
        .catch(() => 0)
    }
  }
  return total
}

/**
 * List every checkpoint store under CHECKPOINTS_DIR with its size. Labels come
 * from the best-effort meta.json written at store creation; otherwise the
 * opaque hash dir name is used. The store for `currentKey` is flagged.
 */
async function listCheckpointStores(currentKey: string): Promise<CacheEntry[]> {
  let dirs: Dirent[]
  try {
    dirs = await readdir(CHECKPOINTS_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const results: CacheEntry[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const full = path.join(CHECKPOINTS_DIR, dir.name)
    // Primary source for the project path: git records `core.worktree` in the
    // store's config for every checkpoint store. meta.json is a secondary
    // source (and carries the last-updated time).
    const worktree = await readFile(path.join(full, 'config'), 'utf8')
      .then(parseGitWorktree)
      .catch(() => undefined)
    const meta = await readFile(path.join(full, META_FILE), 'utf8')
      .then((raw) => JSON.parse(raw) as { cwd?: string; updatedAt?: number })
      .catch(() => undefined)
    // Fall back to the store directory's mtime for stores written before meta
    // carried a timestamp, so age-based cleanup still works for them.
    const mtime = await stat(full)
      .then((s) => s.mtimeMs)
      .catch(() => undefined)
    const cwd = worktree ?? meta?.cwd
    const updatedAt = meta?.updatedAt ?? mtime
    results.push({
      label:
        (cwd ? `${tildify(cwd)}  [${dir.name}]` : dir.name) + `  ${age(updatedAt, Date.now())}`,
      path: full,
      bytes: await measureDir(full),
      current: dir.name === currentKey,
      cwd,
      updatedAt,
    })
  }
  return results
}
