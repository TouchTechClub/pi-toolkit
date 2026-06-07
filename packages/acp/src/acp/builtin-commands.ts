import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentSideConnection, PromptResponse } from '@agentclientprotocol/sdk'
import { parsePiSessionStats, parsePiState } from '../pi-rpc/schemas.js'
import type { PiAcpSession } from './session.js'

/**
 * Built-in ACP slash commands (a headless-friendly subset of pi's interactive commands).
 *
 * These run adapter-side and never reach the model. Each handler receives a {@link CommandContext}
 * and returns a {@link PromptResponse}. Shared chat-reply boilerplate lives in `ctx.reply()`.
 */
export interface CommandContext {
  session: PiAcpSession
  conn: AgentSideConnection
  args: string[]
  /** Send a plain-text assistant message chunk to the client. */
  reply: (text: string) => Promise<void>
}

export type CommandHandler = (ctx: CommandContext) => Promise<PromptResponse>

const END_TURN: PromptResponse = { stopReason: 'end_turn' }

function makeReply(conn: AgentSideConnection, sessionId: string) {
  return (text: string): Promise<void> =>
    conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    })
}

async function handleCompact(ctx: CommandContext): Promise<PromptResponse> {
  const customInstructions = ctx.args.join(' ').trim() || undefined
  const res = await ctx.session.proc.compact(customInstructions)

  const headerLines = [
    `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
    typeof res.tokensBefore === 'number' ? `Tokens before: ${res.tokensBefore}` : null,
  ].filter(Boolean) as string[]

  const text = headerLines.join('\n') + (res.summary ? `\n\n${res.summary}` : '')
  await ctx.reply(text)
  return END_TURN
}

async function handleSession(ctx: CommandContext): Promise<PromptResponse> {
  const stats = parsePiSessionStats(await ctx.session.proc.getSessionStats())

  const lines: string[] = []
  if (stats.sessionId) lines.push(`Session: ${stats.sessionId}`)
  if (stats.sessionFile) lines.push(`Session file: ${stats.sessionFile}`)
  if (typeof stats.totalMessages === 'number') lines.push(`Messages: ${stats.totalMessages}`)
  if (typeof stats.cost === 'number') lines.push(`Cost: ${stats.cost}`)

  const t = stats.tokens
  if (t) {
    const parts: string[] = []
    if (typeof t.input === 'number') parts.push(`in ${t.input}`)
    if (typeof t.output === 'number') parts.push(`out ${t.output}`)
    if (typeof t.cacheRead === 'number') parts.push(`cache read ${t.cacheRead}`)
    if (typeof t.cacheWrite === 'number') parts.push(`cache write ${t.cacheWrite}`)
    if (typeof t.total === 'number') parts.push(`total ${t.total}`)
    if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
  }

  const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`
  await ctx.reply(text)
  return END_TURN
}

async function handleName(ctx: CommandContext): Promise<PromptResponse> {
  const name = ctx.args.join(' ').trim()
  if (!name) {
    await ctx.reply('Usage: /name <name>')
    return END_TURN
  }

  try {
    await ctx.session.proc.setSessionName(name)
  } catch (e) {
    const msg = errorMessage(e)
    const hint = /set_session_name/i.test(msg)
      ? ' This requires a newer pi version that supports `set_session_name` in RPC mode.'
      : ''
    await ctx.reply(`Failed to set session name: ${msg}${hint}`)
    return END_TURN
  }

  await ctx.conn.sessionUpdate({
    sessionId: ctx.session.sessionId,
    update: {
      sessionUpdate: 'session_info_update',
      title: name,
      updatedAt: new Date().toISOString(),
    },
  })
  await ctx.reply(`Session name set: ${name}`)
  return END_TURN
}

/** Shared implementation for /steering and /follow-up (identical control flow). */
async function handleDeliveryMode(
  ctx: CommandContext,
  opts: {
    label: string
    stateKey: 'steeringMode' | 'followUpMode'
    set: (mode: 'all' | 'one-at-a-time') => Promise<void>
    usage: string
  },
): Promise<PromptResponse> {
  const modeRaw = String(ctx.args[0] ?? '').toLowerCase()
  const state = parsePiState(await ctx.session.proc.getState())
  const current = String(state[opts.stateKey] ?? '')

  if (!modeRaw) {
    await ctx.reply(`${opts.label} mode: ${current || 'unknown'}`)
    return END_TURN
  }

  if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
    await ctx.reply(opts.usage)
    return END_TURN
  }

  await opts.set(modeRaw)
  await ctx.reply(`${opts.label} mode set to: ${modeRaw}`)
  return END_TURN
}

function handleSteering(ctx: CommandContext): Promise<PromptResponse> {
  return handleDeliveryMode(ctx, {
    label: 'Steering',
    stateKey: 'steeringMode',
    set: (mode) => ctx.session.proc.setSteeringMode(mode),
    usage: 'Usage: /steering all | /steering one-at-a-time',
  })
}

function handleFollowUp(ctx: CommandContext): Promise<PromptResponse> {
  return handleDeliveryMode(ctx, {
    label: 'Follow-up',
    stateKey: 'followUpMode',
    set: (mode) => ctx.session.proc.setFollowUpMode(mode),
    usage: 'Usage: /follow-up all | /follow-up one-at-a-time',
  })
}

async function handleAutoCompact(ctx: CommandContext): Promise<PromptResponse> {
  const mode = (ctx.args[0] ?? 'toggle').toLowerCase()
  let enabled: boolean | null = null
  if (mode === 'on' || mode === 'true' || mode === 'enable' || mode === 'enabled') enabled = true
  else if (mode === 'off' || mode === 'false' || mode === 'disable' || mode === 'disabled')
    enabled = false

  if (enabled === null) {
    const state = parsePiState(await ctx.session.proc.getState())
    // Toggle: if the state is unknown (e.g. parse fell back to {}), default to
    // enabling auto-compaction. !undefined is true.
    enabled = !state.autoCompactionEnabled
  }

  await ctx.session.proc.setAutoCompaction(enabled)
  await ctx.reply(`Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`)
  return END_TURN
}

function findChangelog(): string | null {
  // 1) Locate the installed pi package by resolving the `pi` executable.
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which'
    const which = spawnSync(whichCmd, ['pi'], { encoding: 'utf-8' })
    const piPath = String(which.stdout ?? '')
      .split(/\r?\n/)[0]
      ?.trim()

    if (piPath) {
      const resolved = realpathSync(piPath)
      const pkgRoot = dirname(dirname(resolved))
      const p = join(pkgRoot, 'CHANGELOG.md')
      if (existsSync(p)) return p
    }
  } catch {
    // ignore
  }

  // 2) Fallback: ask npm where global modules live.
  try {
    const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8' })
    const root = String(npmRoot.stdout ?? '').trim()
    if (root) {
      const p = join(root, '@earendil-works', 'pi-coding-agent', 'CHANGELOG.md')
      if (existsSync(p)) return p
    }
  } catch {
    // ignore
  }

  return null
}

async function handleChangelog(ctx: CommandContext): Promise<PromptResponse> {
  const changelogPath = findChangelog()
  if (!changelogPath) {
    await ctx.reply("Changelog not found (couldn't locate pi installation).")
    return END_TURN
  }

  let text = ''
  try {
    text = readFileSync(changelogPath, 'utf-8')
  } catch (e) {
    await ctx.reply(`Failed to read changelog: ${errorMessage(e)}`)
    return END_TURN
  }

  const maxChars = 20_000
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n...(truncated)...'
  await ctx.reply(text)
  return END_TURN
}

async function handleExport(ctx: CommandContext): Promise<PromptResponse> {
  // pi's export_html reads the session JSONL file. If it doesn't exist yet (no messages) or is
  // empty, pi throws and RPC mode emits an uncorrelated parse error, so we guard up-front.
  const state = parsePiState(await ctx.session.proc.getState())
  const sessionFile = state.sessionFile ?? null
  const messageCount = typeof state.messageCount === 'number' ? state.messageCount : 0

  if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
    await ctx.reply('Nothing to export yet (no session messages). Send a prompt first.')
    return END_TURN
  }

  try {
    const raw = readFileSync(sessionFile, 'utf-8')
    if (raw.trim().length === 0) {
      await ctx.reply('Nothing to export yet (empty session file). Send a prompt first.')
      return END_TURN
    }
  } catch {
    await ctx.reply("Couldn't read session file for export. Try sending a prompt first.")
    return END_TURN
  }

  const safeSessionId = ctx.session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const outputPath = join(ctx.session.cwd, `pi-session-${safeSessionId}.html`)

  let resultPath = ''
  try {
    const result = await ctx.session.proc.exportHtml(outputPath)
    resultPath = result.path
  } catch (e) {
    await ctx.reply(`Export failed: ${errorMessage(e)}`)
    return END_TURN
  }

  if (!resultPath) {
    await ctx.reply('Export failed: no output path returned by pi.')
    return END_TURN
  }

  const uri = `file://${resultPath}`

  // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
  // assistant message, so this avoids the "link + duplicate plain text" look.
  await ctx.reply('Session exported: ')
  await ctx.conn.sessionUpdate({
    sessionId: ctx.session.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'resource_link',
        name: `pi-session-${safeSessionId}.html`,
        uri,
        mimeType: 'text/html',
        title: 'Session exported',
      },
    },
  })

  return END_TURN
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const HANDLERS: Record<string, CommandHandler> = {
  compact: handleCompact,
  session: handleSession,
  name: handleName,
  steering: handleSteering,
  'follow-up': handleFollowUp,
  autocompact: handleAutoCompact,
  changelog: handleChangelog,
  export: handleExport,
}

/** Returns the handler for a built-in command name, or undefined if not built-in. */
export function getBuiltinCommandHandler(name: string): CommandHandler | undefined {
  return HANDLERS[name]
}

/** Build a {@link CommandContext} for dispatching a built-in command. */
export function makeCommandContext(
  session: PiAcpSession,
  conn: AgentSideConnection,
  args: string[],
): CommandContext {
  return {
    session,
    conn,
    args,
    reply: makeReply(conn, session.sessionId),
  }
}
