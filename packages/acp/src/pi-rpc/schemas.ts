import { z } from 'zod'

/**
 * Defensive Zod schemas for pi RPC response payloads.
 *
 * pi is a separate process whose RPC shapes may drift across versions, so every schema here
 * is intentionally permissive: unknown fields are ignored and `.catch(...)`/`.optional()` make
 * parsing total (never throws). Use the exported `parse*` helpers at call sites instead of
 * casting RPC results to `any`.
 */

const thinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])

export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>

const modelRefSchema = z
  .object({
    provider: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
  })
  .passthrough()

/** `get_state` response. */
const piStateSchema = z
  .object({
    sessionId: z.string().nullable().optional(),
    sessionFile: z.string().nullable().optional(),
    messageCount: z.number().nullable().optional(),
    thinkingLevel: z.string().nullable().optional(),
    steeringMode: z.string().nullable().optional(),
    followUpMode: z.string().nullable().optional(),
    autoCompactionEnabled: z.boolean().nullable().optional(),
    model: modelRefSchema.nullable().optional(),
  })
  .passthrough()

export type PiState = z.infer<typeof piStateSchema>

/** One entry in `get_available_models`. */
const availableModelSchema = z
  .object({
    provider: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough()

/** `get_available_models` response. */
const piAvailableModelsSchema = z
  .object({
    models: z.array(availableModelSchema).catch([]),
  })
  .passthrough()

export type PiAvailableModel = z.infer<typeof availableModelSchema>
export type PiAvailableModels = z.infer<typeof piAvailableModelsSchema>

/** `get_session_stats` response. */
const piSessionStatsSchema = z
  .object({
    sessionId: z.string().nullable().optional(),
    sessionFile: z.string().nullable().optional(),
    totalMessages: z.number().nullable().optional(),
    cost: z.number().nullable().optional(),
    tokens: z
      .object({
        input: z.number().nullable().optional(),
        output: z.number().nullable().optional(),
        cacheRead: z.number().nullable().optional(),
        cacheWrite: z.number().nullable().optional(),
        total: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

export type PiSessionStats = z.infer<typeof piSessionStatsSchema>

/** `compact` response. */
const piCompactResultSchema = z
  .object({
    tokensBefore: z.number().nullable().optional(),
    summary: z.string().nullable().optional(),
  })
  .passthrough()

export type PiCompactResult = z.infer<typeof piCompactResultSchema>

/** Parse helpers. Each returns a typed object, falling back to `{}` (or `{ models: [] }`). */

export function parsePiState(data: unknown): PiState {
  const result = piStateSchema.safeParse(data)
  return result.success ? result.data : {}
}

export function parsePiAvailableModels(data: unknown): PiAvailableModels {
  const result = piAvailableModelsSchema.safeParse(data)
  return result.success ? result.data : { models: [] }
}

export function parsePiSessionStats(data: unknown): PiSessionStats {
  const result = piSessionStatsSchema.safeParse(data)
  return result.success ? result.data : {}
}

export function parsePiCompactResult(data: unknown): PiCompactResult {
  const result = piCompactResultSchema.safeParse(data)
  return result.success ? result.data : {}
}

/** Narrow an arbitrary string to a known thinking level. */
export function asThinkingLevel(value: unknown): ThinkingLevel | null {
  const result = thinkingLevelSchema.safeParse(value)
  return result.success ? result.data : null
}

/** `export_html` response. */
const piExportHtmlSchema = z
  .object({
    path: z.string().nullable().optional(),
  })
  .passthrough()

export function parsePiExportHtml(data: unknown): { path: string } {
  const result = piExportHtmlSchema.safeParse(data)
  return { path: result.success ? (result.data.path ?? '') : '' }
}
