import { existsSync, readFileSync } from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk'

export type PiRpcCommandInfo = {
  name?: unknown
  description?: unknown
  source?: unknown
  location?: unknown
  path?: unknown
  sourceInfo?: {
    path?: unknown
    source?: unknown
    scope?: unknown
    origin?: unknown
    baseDir?: unknown
  }
}

function describeFallback(c: PiRpcCommandInfo): string {
  const source = typeof c.source === 'string' ? c.source : ''
  const location = typeof c.location === 'string' ? c.location : ''

  const parts: string[] = []
  if (source) parts.push(source)
  if (location) parts.push(location)

  return parts.length ? `(${parts.join(':')})` : '(command)'
}

function fileDeclaresAcpCompatibility(path: string): boolean {
  try {
    if (!existsSync(path)) return false
    const text = readFileSync(path, 'utf-8')

    // Extensions opt into ACP exposure with a source comment only:
    //   // @pi-acp-compatible
    return /@pi-acp-compatible\b/.test(text)
  } catch {
    return false
  }
}

/**
 * Check whether an extension command (source === 'extension') is ACP-compatible by
 * reading its source file for the `// @pi-acp-compatible` comment.
 *
 * Non-extension commands are always considered compatible.
 */
export function isAcpCompatible(c: PiRpcCommandInfo): boolean {
  const source = typeof c?.source === 'string' ? c.source : ''
  if (source !== 'extension') return true

  // pi reports the extension file path in sourceInfo.path (or path as a fallback)
  const path =
    (typeof c.sourceInfo?.path === 'string' ? c.sourceInfo.path.trim() : '') ||
    (typeof c.path === 'string' ? c.path.trim() : '')
  return Boolean(path && fileDeclaresAcpCompatibility(path))
}

export function toAvailableCommandsFromPiGetCommands(
  data: unknown,
  opts?: { enableSkillCommands?: boolean; includeExtensionCommands?: boolean },
): {
  commands: AvailableCommand[]
  raw: PiRpcCommandInfo[]
} {
  const enableSkillCommands = opts?.enableSkillCommands ?? true
  const includeExtensionCommands = opts?.includeExtensionCommands ?? false

  const root: any = data
  const commandsRaw: PiRpcCommandInfo[] = Array.isArray(root?.commands)
    ? root.commands
    : Array.isArray(root?.data?.commands)
      ? root.data.commands
      : []

  const out: AvailableCommand[] = []

  for (const c of commandsRaw) {
    const name = typeof c?.name === 'string' ? c.name.trim() : ''
    if (!name) continue

    const source = typeof c?.source === 'string' ? c.source : ''
    if (source === 'extension') {
      if (!includeExtensionCommands) continue
      if (!isAcpCompatible(c)) continue
    }

    if (!enableSkillCommands && name.startsWith('skill:')) continue

    const desc = typeof c?.description === 'string' ? c.description.trim() : ''

    out.push({
      name,
      description: desc || describeFallback(c),
    })
  }

  return { commands: out, raw: commandsRaw }
}
