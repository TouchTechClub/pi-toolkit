import type { ToolKind } from '@agentclientprotocol/sdk'

export function toToolTitle(toolName: string, rawInput: unknown): string {
  const args =
    rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : null

  if (toolName === 'bash') {
    const command = getBashCommand(args)
    if (command) {
      const title = `bash ${command}`
      return title.length > 120 ? `${title.slice(0, 117)}...` : title
    }
  }

  const path = typeof args?.path === 'string' ? args.path.trim() : ''
  if (path && (toolName === 'read' || toolName === 'write' || toolName === 'edit'))
    return `${toolName} ${path}`

  return toolName
}

export function getBashCommand(args: Record<string, unknown> | null): string {
  if (!args) return ''

  for (const key of ['command', 'cmd', 'script']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  return ''
}

export function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  const details = (result as any)?.details

  // Some pi tools return a unified diff in `details.diff`.
  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if (
    (typeof stdout === 'string' && stdout.trim()) ||
    (typeof stderr === 'string' && stderr.trim())
  ) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
