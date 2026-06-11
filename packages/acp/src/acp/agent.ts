import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import {
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ModelInfo,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  RequestError,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
} from '@agentclientprotocol/sdk'
import { PiRpcProcess } from '../pi-rpc/process.js'
import {
  asThinkingLevel,
  type PiAvailableModels,
  type PiState,
  parsePiAvailableModels,
  parsePiState,
} from '../pi-rpc/schemas.js'
import { getAuthMethods } from './auth.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { getBuiltinCommandHandler, makeCommandContext } from './builtin-commands.js'
import {
  isAcpCompatible,
  type PiRpcCommandInfo,
  toAvailableCommandsFromPiGetCommands,
} from './pi-commands.js'
import { findPiSessionFile, listPiSessions } from './pi-sessions.js'
import { getAgentDir, getEnableSkillCommands, getQuietStartup } from './pi-settings.js'
import type { PiAcpSession } from './session.js'
import { SessionManager } from './session.js'
import { SessionStore } from './session-store.js'
import { loadSlashCommands, parseCommandArgs, toAvailableCommands } from './slash-commands.js'
import { normalizePiAssistantText, normalizePiMessageText } from './translate/pi-messages.js'
import { todoToolResultToPlanUpdate } from './translate/pi-todos.js'
import { toolResultToText, toToolKind, toToolTitle } from './translate/pi-tools.js'
import { promptToPiMessage } from './translate/prompt.js'

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' },
    },
    {
      name: 'autocompact',
      description: 'Toggle automatic context compaction',
      input: { hint: 'on|off|toggle' },
    },
    {
      name: 'export',
      description: 'Export session to an HTML file in the session cwd',
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost, session file)',
    },
    {
      name: 'name',
      description: 'Set session display name',
      input: { hint: '<name>' },
    },
    {
      name: 'steering',
      description:
        'Get/set pi steering message delivery mode (how queued steering messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' },
    },
    {
      name: 'follow-up',
      description:
        'Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' },
    },
    {
      name: 'changelog',
      description: 'Show pi changelog',
    },
  ]
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = []
  const seen = new Set<string>()

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }

  return out
}

import { fileURLToPath } from 'node:url'

const pkg = readNearestPackageJson(import.meta.url)

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly sessions = new SessionManager()
  private readonly store = new SessionStore()

  dispose(): void {
    this.sessions.disposeAll()
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null

  constructor(conn: AgentSideConnection, _config?: unknown) {
    this.conn = conn
    void _config
  }

  private cleanupFailedNewSession(sessionId: string, state?: PiState | null): void {
    this.sessions.close(sessionId)

    const sessionFile =
      typeof state?.sessionFile === 'string' && state.sessionFile.trim()
        ? state.sessionFile
        : this.store.get(sessionId)?.sessionFile

    if (typeof sessionFile === 'string' && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId)
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // We currently only support ACP protocol version 1.
    const supportedVersion = 1
    const requested = params.protocolVersion

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? 'pi-acp',
        title: 'pi ACP adapter',
        version: pkg.version ?? '0.0.0',
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta:
          (params as any)?.clientCapabilities?._meta?.['terminal-auth'] === true,
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === 'true',
        },
        sessionCapabilities: {
          list: {},
          close: {},
        },
      },
    }
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    this.lastSessionCwd = params.cwd

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND,
    })

    // Fetch state + models once (parallel) to reduce startup latency.
    let state: PiState | null = null
    let availableModels: PiAvailableModels | null = null
    let stateErr: unknown = null
    let availableModelsErr: unknown = null

    await Promise.all([
      session.proc
        .getState()
        .then((s) => {
          state = parsePiState(s)
        })
        .catch((err) => {
          stateErr = err
          state = null
        }),
      session.proc
        .getAvailableModels()
        .then((m) => {
          availableModels = parsePiAvailableModels(m)
        })
        .catch((err) => {
          availableModelsErr = err
          availableModels = null
        }),
    ])

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr)

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw availableModelsAuthErr
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.internalError(
        {},
        String((availableModelsErr as Error)?.message ?? availableModelsErr),
      )
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = (availableModels as PiAvailableModels | null)?.models.length ?? 0

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.',
      )
    }

    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.',
      )
    }

    const models = await getModelState(session.proc, { state, availableModels })
    const thinking = await getThinkingState(session.proc, { state })

    const quietStartup = getQuietStartup(params.cwd)
    const updateNotice = buildUpdateNotice()

    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    const preludeText = quietStartup
      ? updateNotice
        ? updateNotice + '\n'
        : ''
      : buildStartupInfo({
          cwd: params.cwd,
          fileCommands,
          updateNotice,
        })

    if (preludeText)
      session.setStartupInfo(preludeText)

      // Policy: within a single ACP connection (one client window), keep only one live pi subprocess.
      // This avoids leaking subprocesses when clients start new sessions but don't explicitly close old ones.
      // It does NOT affect other client windows because they run in separate agent processes.
      //
      // (Tests sometimes stub out `this.sessions`, so guard the call.)
    ;(this.sessions as any).closeAllExcept?.(session.sessionId)

    const configOptions = buildConfigOptions(models, thinking)

    const response = {
      sessionId: session.sessionId,
      models,
      modes: thinking,
      configOptions,
      _meta: {
        piAcp: {
          startupInfo: preludeText || null,
        },
      },
    }

    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0)

    // Advertise slash commands (ACP: available_commands_update)
    // Important: some clients (e.g. Zed) will ignore notifications for an unknown sessionId.
    // So we must send this *after* the session/new response has been delivered.
    setTimeout(() => {
      void (async () => {
        try {
          const pi = (await session.proc.getCommands()) as any
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: true,
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands()),
            },
          })
          return
        } catch {
          // Fall back to file-based prompt templates (legacy behavior).
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(
              toAvailableCommands(fileCommands),
              builtinAvailableCommands(),
            ),
          },
        })
      })()
    }, 0)

    return response
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    return
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId)

    const { message, images } = promptToPiMessage(params.prompt)

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)

      const handler = getBuiltinCommandHandler(cmd)
      if (handler) {
        return handler(makeCommandContext(session, this.conn, args))
      }

      // Extension commands must opt into ACP compatibility via `// @pi-acp-compatible`.
      const extensionResult = await this.tryRunExtensionCommand(session, cmd, message, images)
      if (extensionResult) return extensionResult
    }

    const result = await session.prompt(message, images)

    // ACP StopReason does not include "error"; if pi fails we map to end_turn for now,
    // unless we know this was a cancellation.
    const stopReason: StopReason =
      result === 'error' ? (session.wasCancelRequested() ? 'cancelled' : 'end_turn') : result

    return { stopReason }
  }

  /**
   * Attempt to run an ACP-compatible extension command. Returns a {@link PromptResponse} if the
   * command was handled (run or rejected as incompatible), or `undefined` to let pi handle the
   * prompt normally (unknown command or command discovery failed).
   */
  private async tryRunExtensionCommand(
    session: PiAcpSession,
    cmd: string,
    message: string,
    images: unknown[],
  ): Promise<PromptResponse | undefined> {
    const reply = (text: string) =>
      this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      })

    let raw: PiRpcCommandInfo[]
    try {
      const pi = (await session.proc.getCommands()) as any
      raw = Array.isArray(pi?.commands)
        ? pi.commands
        : Array.isArray(pi?.data?.commands)
          ? pi.data.commands
          : []
    } catch {
      // If command discovery fails, let pi handle the prompt normally.
      return undefined
    }

    const piCommand = raw.find((c) => typeof c?.name === 'string' && c.name.trim() === cmd)
    if (!piCommand || piCommand.source !== 'extension') return undefined

    if (!isAcpCompatible(piCommand)) {
      await reply(`The /${cmd} extension command is not marked ACP-compatible.`)
      return { stopReason: 'end_turn' }
    }

    try {
      await session.proc.prompt(message, images)
      await reply(`Ran /${cmd}.`)
    } catch (e) {
      await reply(`/${cmd} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    return { stopReason: 'end_turn' }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    await session.cancel()
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP: filter by cwd if provided. Some clients send `{}` (no cwd), so we default
    // to the last session cwd to emulate pi's project-scoped `/resume` picker.
    const all = listPiSessions()

    const requestedCwd = params.cwd ?? null
    if (requestedCwd && !isAbsolute(requestedCwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${requestedCwd}`)
    }

    const additionalDirectories = Array.isArray((params as any).additionalDirectories)
      ? ((params as any).additionalDirectories as unknown[])
      : []
    for (const dir of additionalDirectories) {
      if (typeof dir !== 'string' || !isAbsolute(dir)) {
        throw RequestError.invalidParams(
          `additionalDirectories entries must be absolute paths: ${String(dir)}`,
        )
      }
    }

    const effectiveCwd = requestedCwd ?? this.lastSessionCwd
    const filtered = effectiveCwd ? all.filter((s) => s.cwd === effectiveCwd) : all

    // Cursor-based pagination. The cursor is opaque to clients; internally we use
    // a non-negative numeric offset and reject malformed cursors per the spec.
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0
    if (
      params.cursor &&
      (!Number.isFinite(offset) || offset < 0 || String(offset) !== params.cursor)
    ) {
      throw RequestError.invalidParams('Invalid session/list cursor')
    }
    const start = offset

    const PAGE_SIZE = 50
    const page = filtered.slice(start, start + PAGE_SIZE)

    const sessions: SessionInfo[] = page.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt,
    }))

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  // Backwards-compatible alias for older SDKs/clients that routed session/list here.
  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.listSessions(params)
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.sessions.maybeGet(params.sessionId)
    if (!session) throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)

    try {
      await session.cancel()
    } finally {
      this.sessions.close(params.sessionId)
    }

    return {}
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    // If the client is re-loading a session that is already active, tear down the existing
    // pi subprocess so we can start fresh and re-advertise commands reliably.
    // (Some clients may call session/load when restoring from history.)
    this.sessions.close(params.sessionId)

    this.lastSessionCwd = params.cwd

    // MVP: ignore mcpServers.
    // Prefer ACP-created mapping first (fast path), otherwise scan pi sessions dir.
    const stored = this.store.get(params.sessionId)
    const sessionFile = stored?.sessionFile ?? findPiSessionFile(params.sessionId)

    if (!sessionFile) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)
    }

    // Spawn pi and point it directly at the session file.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
      })
    } catch (e: any) {
      if (e?.name === 'PiRpcSpawnError') {
        throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e))
      }
      throw e
    }

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    const session = this.sessions.getOrCreate(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      proc,
      fileCommands,
    })

    // (Optional) ensure mapping stays fresh.
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile,
    })

    // Replay full conversation history.
    const data = (await proc.getMessages()) as any
    const messages = Array.isArray(data?.messages) ? data.messages : []

    // First pass: build a toolCallId → args map from assistant messages so
    // we can populate tool titles during the toolResult replay pass.
    const toolCallArgs = new Map<string, { toolName: string; args: unknown }>()
    for (const m of messages) {
      const role = String(m?.role ?? (m as any)?.message?.role ?? '')
      if (role !== 'assistant') continue

      const content = Array.isArray(m?.content)
        ? m.content
        : Array.isArray((m as any)?.message?.content)
          ? (m as any).message.content
          : []

      for (const block of content) {
        if (block?.type === 'toolCall' || block?.type === 'tool_use') {
          const id = String(block?.id ?? '')
          const name = String(block?.name ?? 'tool')
          if (id) {
            toolCallArgs.set(id, { toolName: name, args: block?.arguments ?? null })
          }
        }
      }
    }

    for (const m of messages) {
      // pi may nest role under `message` (JSONL format) or keep it at top level (RPC-normalized).
      const role = String(m?.role ?? (m as any)?.message?.role ?? '')

      if (role === 'user') {
        const content = m?.content ?? (m as any)?.message?.content
        const text = normalizePiMessageText(content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text },
            },
          })
        }
      }

      if (role === 'assistant') {
        const content = m?.content ?? (m as any)?.message?.content
        const text = normalizePiAssistantText(content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          })
        }
      }

      if (role === 'toolResult') {
        // pi may nest fields under `message` (JSONL) or keep them at top level (RPC).
        const inner = (m as any)?.message ?? m
        const toolCallId = String(inner?.toolCallId ?? crypto.randomUUID())
        const isError = Boolean(inner?.isError)

        // Prefer the tool name + args from the original assistant tool call.
        const tc = toolCallArgs.get(toolCallId)
        const toolName = tc?.toolName ?? String(inner?.toolName ?? 'tool')
        const rawInput = tc?.args ?? null

        // Create a synthetic ACP tool call to render historic tool usage.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toToolTitle(toolName, rawInput, params.cwd),
            kind: toToolKind(toolName),
            status: 'completed',
            rawInput,
            rawOutput: m,
          },
        })

        const planUpdate = todoToolResultToPlanUpdate(toolName, m)
        if (planUpdate) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: planUpdate,
          })
        }

        const text = toolResultToText(m)
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: isError ? 'failed' : 'completed',
            content: text ? [{ type: 'content', content: { type: 'text', text } }] : null,
            rawOutput: m,
          },
        })
      }
    }

    const models = await getModelState(proc)
    const thinking = await getThinkingState(proc)
    const configOptions = buildConfigOptions(models, thinking)

    const response = {
      models,
      modes: thinking,
      configOptions,
      _meta: {
        piAcp: {
          startupInfo: null,
        },
      },
    }

    // Advertise slash commands after the response so the client knows the session exists.
    setTimeout(() => {
      void (async () => {
        try {
          const pi = (await proc.getCommands()) as any
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: true,
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands()),
            },
          })
          return
        } catch {
          // fall back
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(
              toAvailableCommands(fileCommands),
              builtinAvailableCommands(),
            ),
          },
        })
      })()
    }, 0)

    return response
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    await setPiModel(session.proc, params.modelId)
    // Emit config option update to reflect the new model in modern clients.
    void this.emitModelConfigUpdate(session)
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId)

    const mode = String(params.modeId)
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`)
    }

    await session.proc.setThinkingLevel(mode)

    // Let the client know the current mode changed (keeps legacy mode dropdowns in sync).
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: mode,
      },
    })

    // Also emit config_option_update for modern clients that use configOptions.
    void this.emitThinkingConfigUpdate(session.sessionId, mode)

    return {}
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId)

    const configId = (params as any).configId as string

    if (configId === 'model') {
      const value = (params as { value: string }).value
      if (typeof value !== 'string' || !value) {
        throw RequestError.invalidParams('model value must be a non-empty string')
      }
      await setPiModel(session.proc, value)
      // Emit config option update to reflect the new model in UI.
      void this.emitModelConfigUpdate(session)
      return this.buildConfigOptionResponse(session)
    }

    if (configId === 'thought_level') {
      const value = (params as { value: string }).value
      if (typeof value !== 'string' || !value) {
        throw RequestError.invalidParams('thought_level value must be a non-empty string')
      }
      if (!isThinkingLevel(value)) {
        throw RequestError.invalidParams(`Unknown thinking level: ${value}`)
      }
      await session.proc.setThinkingLevel(value)
      return this.buildConfigOptionResponse(session)
    }

    throw RequestError.invalidParams(`Unknown config option: ${configId}`)
  }

  /** Build a SetSessionConfigOptionResponse from the current session state. */
  private async buildConfigOptionResponse(
    session: PiAcpSession,
  ): Promise<SetSessionConfigOptionResponse> {
    const models = await getModelState(session.proc)
    const thinking = await getThinkingState(session.proc)
    const configOptions = buildConfigOptions(models, thinking)
    return { configOptions }
  }

  /** Emit a config_option_update reflecting the current model. */
  private async emitModelConfigUpdate(session: PiAcpSession): Promise<void> {
    try {
      const models = await getModelState(session.proc)
      const thinking = await getThinkingState(session.proc)
      const configOptions = buildConfigOptions(models, thinking)

      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions,
        },
      })
    } catch {
      // Best-effort; ignore failures.
    }
  }

  /** Emit a config_option_update reflecting the current thinking level. */
  private async emitThinkingConfigUpdate(sessionId: string, thinkingLevel: string): Promise<void> {
    try {
      const session = this.sessions.get(sessionId)
      const models = await getModelState(session.proc)
      const thinking = {
        currentModeId: thinkingLevel,
        availableModes: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((id) => ({
          id,
          name: `Thinking: ${id}`,
          description: null,
        })),
      }
      const configOptions = buildConfigOptions(models, thinking)

      void this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions,
        },
      })
    } catch {
      // Best-effort; ignore failures.
    }
  }
}

function isThinkingLevel(x: string): x is ThinkingLevel {
  return (
    x === 'off' || x === 'minimal' || x === 'low' || x === 'medium' || x === 'high' || x === 'xhigh'
  )
}

async function setPiModel(proc: PiRpcProcess, requestedModelId: string): Promise<void> {
  // Accept either:
  //  - "provider/model" (preferred, matches how we advertise)
  //  - "model" (fallback, resolved via available models)
  let provider: string | null = null
  let modelId: string | null = null

  if (requestedModelId.includes('/')) {
    const [p, ...rest] = requestedModelId.split('/')
    provider = p
    modelId = rest.join('/')
  } else {
    modelId = requestedModelId
  }

  if (!provider) {
    const data = parsePiAvailableModels(await proc.getAvailableModels())
    const found = data.models.find((m) => m.id === modelId)
    if (found?.provider && found.id) {
      provider = found.provider
      modelId = found.id
    }
  }

  if (!provider || !modelId) {
    throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`)
  }

  await proc.setModel(provider, modelId)
}

async function getThinkingState(
  proc: PiRpcProcess,
  pre?: { state?: PiState | null },
): Promise<{
  availableModes: Array<{
    id: string
    name: string
    description?: string | null
  }>
  currentModeId: string
}> {
  // Ask pi for current thinking level.
  let current: ThinkingLevel = 'medium'

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return parsePiState(await proc.getState())
      } catch {
        return null
      }
    })())

  const tl = asThinkingLevel(state?.thinkingLevel)
  if (tl) current = tl

  const available: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

  return {
    currentModeId: current,
    availableModes: available.map((id) => ({
      id,
      name: `Thinking: ${id}`,
      description: null,
    })),
  }
}

async function getModelState(
  proc: PiRpcProcess,
  pre?: { state?: PiState | null; availableModels?: PiAvailableModels | null },
): Promise<{
  availableModels: ModelInfo[]
  currentModelId: string
} | null> {
  // Ask pi for available models.
  let availableModels: ModelInfo[] = []

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        return parsePiAvailableModels(await proc.getAvailableModels())
      } catch {
        return null
      }
    })())

  availableModels = (data?.models ?? [])
    .map((m) => {
      const provider = String(m.provider ?? '').trim()
      const id = String(m.id ?? '').trim()
      if (!provider || !id) return null

      const name = String(m.name ?? id)
      return {
        modelId: `${provider}/${id}`,
        name: `${provider}/${name}`,
        description: null,
      } satisfies ModelInfo
    })
    .filter(Boolean) as ModelInfo[]

  // Ask pi what model is currently active.
  let currentModelId: string | null = null

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return parsePiState(await proc.getState())
      } catch {
        return null
      }
    })())

  const model = state?.model
  if (model) {
    const provider = String(model.provider ?? '').trim()
    const id = String(model.id ?? '').trim()
    if (provider && id) currentModelId = `${provider}/${id}`
  }

  if (!availableModels.length && !currentModelId) return null

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? 'default'

  return {
    availableModels,
    currentModelId,
  }
}

function buildConfigOptions(
  modelState: Awaited<ReturnType<typeof getModelState>>,
  thinkingState: Awaited<ReturnType<typeof getThinkingState>>,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = []

  // Model selector grouped by provider.
  if (modelState?.availableModels.length) {
    const currentModelId = modelState.currentModelId

    // Group models by provider.
    const groups = new Map<string, { provider: string; models: ModelInfo[] }>()
    for (const m of modelState.availableModels) {
      const [provider] = m.modelId.split('/')
      if (!provider) continue
      const entry = groups.get(provider)
      if (entry) {
        entry.models.push(m)
      } else {
        groups.set(provider, { provider, models: [m] })
      }
    }

    // Sort providers for stable output.
    const sortedProviders = [...groups.keys()].sort()

    const selectOptions: SessionConfigSelectGroup[] = sortedProviders.map((provider) => {
      const group = groups.get(provider)!
      return {
        group: provider,
        name: provider,
        options: group.models.map(
          (m) =>
            ({
              value: m.modelId,
              name: m.name.startsWith(`${provider}/`) ? m.name.slice(provider.length + 1) : m.name,
              description: null,
            }) satisfies SessionConfigSelectOption,
        ),
      } satisfies SessionConfigSelectGroup
    })

    options.push({
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      description: null,
      currentValue: currentModelId,
      options: selectOptions,
    })
  }

  // Thinking level selector.
  options.push({
    type: 'select',
    id: 'thought_level',
    name: 'Thinking',
    category: 'thought_level',
    description: null,
    currentValue: thinkingState.currentModeId,
    options: thinkingState.availableModes.map(
      (m) =>
        ({
          value: m.id,
          name: m.name,
          description: m.description,
        }) satisfies SessionConfigSelectOption,
    ),
  })

  return options
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v)
}

function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number(n))
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number(n))
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

function buildUpdateNotice(): string | null {
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (
      String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()
    ).replace(/^v/i, '')

    if (!installed || !isSemver(installed)) return null

    const latestRes = spawnSync('npm', ['view', '@earendil-works/pi-coding-agent', 'version'], {
      encoding: 'utf-8',
      timeout: 800,
    })
    const latest = String(latestRes.stdout ?? '')
      .trim()
      .replace(/^v/i, '')

    if (!latest || !isSemver(latest)) return null
    if (compareSemver(latest, installed) <= 0) return null

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``
  } catch {
    return null
  }
}

/** Parse PI_ACP_EXTRA_PI_ARGS into an array of individual flags/values. */
function parseExtraPiArgs(): string[] {
  const raw = process.env.PI_ACP_EXTRA_PI_ARGS
  if (!raw) return []
  const parsed = raw.match(/(?:'[^']*'|"[^"]*"|\S)+/g) ?? []
  return parsed.map((a) => a.replace(/^(['"])(.*)\1$/, '$2'))
}

function buildStartupInfo(opts: {
  cwd: string
  fileCommands: ReturnType<typeof loadSlashCommands>
  updateNotice: string | null
}): string {
  void opts.fileCommands

  const md: string[] = []

  // pi version header
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (
      String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()
    ).replace(/^v/i, '')
    if (installed) {
      md.push(`pi v${installed}`)
      md.push('---')
      md.push('')
    }
  } catch {
    // ignore
  }

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map((s) => s.trim()).filter(Boolean)
    if (!cleaned.length) return

    md.push(`## ${title}`)
    for (const item of cleaned) md.push(`- ${item}`)
    md.push('')
  }

  // Context
  const contextItems: string[] = []
  const contextPath = join(opts.cwd, 'AGENTS.md')
  if (existsSync(contextPath)) contextItems.push(contextPath)
  addSection('Context', contextItems)

  // Skills
  const skillsItems: string[] = []

  const pushSkillFromRoot = (root: string) => {
    try {
      // Direct .md files in root
      for (const e of readdirSync(root)) {
        const p = join(root, e)
        try {
          const st = statSync(p)
          if (st.isFile() && e.toLowerCase().endsWith('.md')) {
            skillsItems.push(p)
          }
        } catch {
          // ignore
        }
      }

      // Recursive SKILL.md under subdirectories
      const stack: string[] = [root]
      while (stack.length) {
        const dir = stack.pop()!
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }

        for (const name of entries) {
          // Skip obvious noise
          if (name === 'node_modules' || name === '.git') continue
          const p = join(dir, name)
          let st
          try {
            st = statSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            stack.push(p)
          } else if (st.isFile() && name === 'SKILL.md') {
            skillsItems.push(p)
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Global skills
  // Use getAgentDir() so this respects PI_CODING_AGENT_DIR overrides.
  const globalSkillsDir = join(getAgentDir(), 'skills')
  pushSkillFromRoot(globalSkillsDir)

  // Also support ~/.agents/skills (pi skill discovery)
  const legacyAgentsSkillsDir = join(process.env.HOME ?? '', '.agents', 'skills')
  pushSkillFromRoot(legacyAgentsSkillsDir)

  // Project skills (.pi/skills)
  const projectSkillsDir = join(opts.cwd, '.pi', 'skills')
  pushSkillFromRoot(projectSkillsDir)

  addSection('Skills', skillsItems)

  // Prompts
  const promptsItems: string[] = []
  const agentDir = getAgentDir()
  const promptsDir = join(agentDir, 'prompts')
  try {
    const prompts = readdirSync(promptsDir).filter((f) => f.endsWith('.md'))
    for (const f of prompts) promptsItems.push(`/${basename(f, '.md')}`)
  } catch {
    // ignore
  }
  addSection('Prompts', promptsItems)

  // Extensions
  const extItems: string[] = []

  // If pi is being launched with --no-extensions, only show explicit --extension flags
  // from PI_ACP_EXTRA_PI_ARGS rather than guessing from settings files on disk.
  const extraArgs = parseExtraPiArgs()
  const noExtensions = extraArgs.includes('--no-extensions') || extraArgs.includes('-ne')

  if (noExtensions) {
    // Collect explicit --extension/-e paths. Each flag consumes the next arg as its value.
    let i = 0
    while (i < extraArgs.length) {
      if (extraArgs[i] === '--extension' || extraArgs[i] === '-e') {
        const path = extraArgs[i + 1]
        if (path && !path.startsWith('-')) {
          extItems.push(path)
          i += 2 // skip the flag and its value
        } else {
          i++
        }
      } else {
        i++
      }
    }
  } else {
    // Normal discovery: show extensions from disk and packages from settings.
    const extDir = join(agentDir, 'extensions')
    try {
      const exts = readdirSync(extDir).filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
      for (const f of exts) extItems.push(join(extDir, f))
    } catch {
      // ignore
    }

    // Show packages from pi settings (global + project)
    const seenPackages = new Set<string>()
    for (const settingsPath of [
      join(agentDir, 'settings.json'),
      join(opts.cwd, '.pi', 'settings.json'),
    ]) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as any
        const pkgs: string[] = Array.isArray(settings?.packages) ? settings.packages : []
        for (const pkg of pkgs) {
          const s = typeof pkg === 'string' ? pkg : String((pkg as any)?.source ?? pkg)
          if (!s || seenPackages.has(s)) continue
          seenPackages.add(s)
          if (s.startsWith('npm:')) {
            extItems.push(`${s}\n  - index.ts`)
          } else {
            extItems.push(s)
          }
        }
      } catch {
        // ignore
      }
    }
  }

  addSection('Extensions', extItems)

  if (opts.updateNotice) {
    md.push('---')
    md.push(opts.updateNotice)
    md.push('')
  }

  // Do NOT include themes (per request).
  return md.join('\n').trim() + '\n'
}

function readNearestPackageJson(metaUrl: string): {
  name?: string
  version?: string
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl))

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, 'utf-8')) as any
        return { name: json?.name, version: json?.version }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'pi-acp', version: '0.0.0' }
}
