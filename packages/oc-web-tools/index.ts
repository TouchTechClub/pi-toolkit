// @pi-acp-compatible

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import TurndownService from 'turndown'
import { Type } from 'typebox'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_FETCH_TIMEOUT = 30_000 // 30 seconds
const MAX_FETCH_TIMEOUT = 120_000 // 2 minutes
const SEARCH_TIMEOUT = 25_000 // 25 seconds
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

// MCP Search endpoints
const EXA_BASE = 'https://mcp.exa.ai/mcp'
const PARALLEL_URL = 'https://search.parallel.ai/mcp'

// ---------------------------------------------------------------------------
// Image MIME detection (browser-friendly list)
// ---------------------------------------------------------------------------

const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exaUrl(): string {
  const key = process.env.EXA_API_KEY
  return key ? `${EXA_BASE}?exaApiKey=${encodeURIComponent(key)}` : EXA_BASE
}

function parallelAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': `pi-oc-web-tools/0.1.0`,
  }
  if (process.env.PARALLEL_API_KEY) {
    headers.Authorization = `Bearer ${process.env.PARALLEL_API_KEY}`
  }
  return headers
}

function selectWebSearchProvider(): 'exa' | 'parallel' {
  const override = process.env.OC_WEBSEARCH_PROVIDER
  if (override === 'exa' || override === 'parallel') return override
  if (process.env.PARALLEL_API_KEY) return 'parallel'
  if (process.env.EXA_API_KEY) return 'exa'
  // Fall back to Exa (no key = public tier)
  return 'exa'
}

function isImageAttachment(mime: string): boolean {
  return IMAGE_MIMES.has(mime.split(';')[0]?.trim().toLowerCase() ?? '')
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + `\n\n... [${text.length - maxChars} characters truncated] ...`
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC Transport
// ---------------------------------------------------------------------------

interface McpContentItem {
  type: string
  text?: string
}

interface McpResult {
  result?: {
    content?: McpContentItem[]
  }
}

interface McpError {
  error?: {
    code: number
    message: string
  }
}

/**
 * Parse a single JSON payload from an MCP response.
 * Handles both raw JSON and SSE `data: {...}` lines.
 */
function parseMcpPayload(payload: string): string | undefined {
  const trimmed = payload.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const data = JSON.parse(trimmed) as McpResult
    return data.result?.content?.find((item) => item.type === 'text' && item.text)?.text
  } catch {
    return undefined
  }
}

/**
 * Parse a complete MCP response body (raw JSON or SSE stream).
 */
function parseMcpResponse(body: string): string | undefined {
  const trimmed = body.trim()
  // Try direct JSON first
  const direct = parseMcpPayload(trimmed)
  if (direct) return direct

  // Try SSE lines
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = parseMcpPayload(line.slice(6))
    if (data) return data
  }

  // Check for JSON-RPC error
  try {
    const err = JSON.parse(trimmed) as McpError
    if (err.error) return `MCP error [${err.error.code}]: ${err.error.message}`
  } catch {
    // ignore
  }

  return undefined
}

/**
 * Call an MCP tool over HTTP with JSON-RPC 2.0 framing.
 */
async function callMcpTool(
  url: string,
  toolName: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT)
  const linkedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
      signal: linkedSignal,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      throw new Error(
        `MCP request failed: HTTP ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody.slice(0, 200)}` : ''}`,
      )
    }

    const body = await response.text()
    return parseMcpResponse(body)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`${toolName} request timed out after ${SEARCH_TIMEOUT / 1000}s`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// HTML Processing
// ---------------------------------------------------------------------------

const turndownService = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
})

turndownService.remove(['script', 'style', 'meta', 'link', 'noscript'])

function htmlToMarkdown(html: string): string {
  return turndownService.turndown(html)
}

function htmlToText(html: string): string {
  // Simple tag-stripping text extraction
  let text = ''
  let skip = 0
  const skipTags = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed'])

  const regex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g
  let lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = regex.exec(html)) !== null) {
    // Text before this tag
    if (skip === 0 && match.index > lastIndex) {
      text += html.slice(lastIndex, match.index)
    }
    lastIndex = regex.lastIndex

    const tag = match[1]?.toLowerCase()
    if (!tag) continue

    if (match[0].startsWith('</')) {
      if (skip > 0) skip--
    } else if (!match[0].endsWith('/>') && skipTags.has(tag)) {
      skip++
    }
  }

  // Remaining text
  if (skip === 0 && lastIndex < html.length) {
    text += html.slice(lastIndex)
  }

  // Clean up whitespace
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// webfetch Tool
// ---------------------------------------------------------------------------

const WebFetchParams = Type.Object({
  url: Type.String({ description: 'The URL to fetch content from' }),
  format: Type.Optional(
    Type.Union([Type.Literal('markdown'), Type.Literal('text'), Type.Literal('html')], {
      default: 'markdown',
    }),
  ),
  timeout: Type.Optional(Type.Number({ description: 'Optional timeout in seconds (max 120)' })),
})

const WEBFETCH_DESCRIPTION = `- Fetches content from a specified URL
- Takes a URL and optional format as input
- Fetches the URL content, converts to requested format (markdown by default)
- Returns the content in the specified format
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - The URL must be a fully-formed valid URL starting with http:// or https://
  - Format options: "markdown" (default), "text", or "html"
  - This tool is read-only and does not modify any files
  - Results may be truncated if the content is very large (max ${MAX_RESPONSE_SIZE / (1024 * 1024)}MB)`

// ---------------------------------------------------------------------------
// websearch Tool
// ---------------------------------------------------------------------------

const WebSearchParams = Type.Object({
  query: Type.String({ description: 'Web search query' }),
  numResults: Type.Optional(
    Type.Number({ description: 'Number of search results to return (default: 8)' }),
  ),
  livecrawl: Type.Optional(Type.Union([Type.Literal('fallback'), Type.Literal('preferred')])),
  type: Type.Optional(
    Type.Union([Type.Literal('auto'), Type.Literal('fast'), Type.Literal('deep')]),
  ),
  contextMaxCharacters: Type.Optional(
    Type.Number({
      description: 'Maximum characters for context string optimized for LLMs (default: 10000)',
    }),
  ),
})

const WEBSEARCH_DESCRIPTION = `- Search the web using a MCP-based web search provider — performs real-time web searches and can scrape content from specific URLs
- Provides up-to-date information for current events and recent data
- Supports configurable result counts and returns the content from the most relevant websites
- Use this tool for accessing information beyond your knowledge cutoff
- Searches are performed automatically within a single API call

Usage notes:
  - Supports live crawling modes when available: 'fallback' (backup if cached unavailable) or 'preferred' (prioritize live crawling)
  - Search types when available: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search)
  - Configurable context length for optimal LLM integration
  - Domain filtering and advanced search options available
  - Configure via EXA_API_KEY or PARALLEL_API_KEY environment variables
  - Override provider selection with OC_WEBSEARCH_PROVIDER=exa|parallel`

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function webTools(pi: ExtensionAPI) {
  // ---- webfetch tool ----
  pi.registerTool({
    name: 'webfetch',
    label: 'Web Fetch',
    description: WEBFETCH_DESCRIPTION,
    promptSnippet: 'Fetch content from a URL and return as markdown, text, or HTML',
    promptGuidelines: [
      'Use webfetch to retrieve and analyze web content from public URLs.',
      'The URL must start with http:// or https://. HTTP URLs will be upgraded by the server.',
      'Prefer format=markdown (default) for readability. Use format=text for plain extraction or format=html for raw HTML.',
      'webfetch is read-only and does not modify any files.',
    ],
    parameters: WebFetchParams,

    async execute(_toolCallId, params, signal) {
      const url = params.url as string
      const format = (params.format as string) || 'markdown'
      const timeoutMs = Math.min(
        ((params.timeout as number) ?? DEFAULT_FETCH_TIMEOUT / 1000) * 1000,
        MAX_FETCH_TIMEOUT,
      )

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return {
          content: [{ type: 'text', text: 'Error: URL must start with http:// or https://' }],
          details: { error: true, reason: 'invalid_url' },
        }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      const linkedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal

      try {
        // Build Accept header based on requested format
        let acceptHeader = '*/*'
        switch (format) {
          case 'markdown':
            acceptHeader =
              'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1'
            break
          case 'text':
            acceptHeader = 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1'
            break
          case 'html':
            acceptHeader =
              'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1'
            break
        }

        const response = await fetch(url, {
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            Accept: acceptHeader,
            'Accept-Language': 'en-US,en;q=0.9',
          },
          signal: linkedSignal,
        })

        // On Cloudflare bot-detection 403, retry with honest UA
        let finalResponse = response
        if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge') {
          finalResponse = await fetch(url, {
            headers: {
              'User-Agent': 'pi-oc-web-tools',
              Accept: acceptHeader,
              'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: linkedSignal,
          })
        }

        if (!finalResponse.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `Error fetching URL: HTTP ${finalResponse.status} ${finalResponse.statusText}`,
              },
            ],
            details: { error: true, status: finalResponse.status, url },
          }
        }

        // Check content length
        const contentLength = finalResponse.headers.get('content-length')
        if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Response too large (${contentLength} bytes exceeds ${MAX_RESPONSE_SIZE / (1024 * 1024)}MB limit)`,
              },
            ],
            details: { error: true, reason: 'too_large', url },
          }
        }

        const contentType = finalResponse.headers.get('content-type') || ''
        const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''

        const arrayBuffer = await finalResponse.arrayBuffer()
        if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Response too large (exceeds ${MAX_RESPONSE_SIZE / (1024 * 1024)}MB limit)`,
              },
            ],
            details: { error: true, reason: 'too_large', url },
          }
        }

        // Handle images — return as description with metadata about the image
        if (isImageAttachment(mime)) {
          const sizeKB = Math.round(arrayBuffer.byteLength / 1024)
          return {
            content: [
              {
                type: 'text',
                text: `Image fetched successfully: ${mime}, ${sizeKB}KB, URL: ${url}`,
              },
            ],
            details: { url, contentType, mime, sizeBytes: arrayBuffer.byteLength },
          }
        }

        const content = new TextDecoder().decode(arrayBuffer)

        // Process content based on requested format and actual content type
        let output: string
        switch (format) {
          case 'markdown':
            if (contentType.includes('text/html')) {
              output = htmlToMarkdown(content)
            } else {
              output = content
            }
            break
          case 'text':
            if (contentType.includes('text/html')) {
              output = htmlToText(content)
            } else {
              output = content
            }
            break
          default:
            output = content
            break
        }

        const truncated = output.length > 50_000
        if (truncated) {
          output = truncateText(output, 50_000)
        }

        return {
          content: [{ type: 'text', text: output }],
          details: {
            url,
            format,
            contentType,
            truncated,
            sizeBytes: arrayBuffer.byteLength,
          },
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Request timed out after ${timeoutMs / 1000}s`,
              },
            ],
            details: { error: true, reason: 'timeout', url },
          }
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: 'text', text: `Error fetching URL: ${message}` }],
          details: { error: true, reason: 'fetch_error', url, message },
        }
      } finally {
        clearTimeout(timeout)
      }
    },
  })

  // ---- websearch tool ----
  pi.registerTool({
    name: 'websearch',
    label: 'Web Search',
    description: WEBSEARCH_DESCRIPTION,
    promptSnippet:
      'Search the web for current information using MCP-based search providers (Exa, Parallel)',
    promptGuidelines: [
      'Use websearch to access information beyond your knowledge cutoff — current events, recent data, and real-time information.',
      'Configure via EXA_API_KEY or PARALLEL_API_KEY environment variables. Set OC_WEBSEARCH_PROVIDER=exa|parallel to override auto-detection.',
      'Search results are returned in an LLM-optimized format. You can control result count and context length via parameters.',
      "Include the current year in queries when searching for recent information. Example: 'AI news 2026' not 'AI news 2025'.",
    ],
    parameters: WebSearchParams,

    async execute(_toolCallId, params, signal) {
      const query = params.query as string
      const provider = selectWebSearchProvider()
      const providerLabel = provider === 'parallel' ? 'Parallel Web Search' : 'Exa Web Search'

      try {
        let result: string | undefined

        if (provider === 'parallel') {
          result = await callMcpTool(
            PARALLEL_URL,
            'web_search',
            {
              objective: query,
              search_queries: [query],
              model_name: undefined,
            },
            parallelAuthHeaders(),
            signal,
          )
        } else {
          // Exa
          result = await callMcpTool(
            exaUrl(),
            'web_search_exa',
            {
              query,
              type: (params.type as string) || 'auto',
              numResults: (params.numResults as number) || 8,
              livecrawl: (params.livecrawl as string) || 'fallback',
              ...(params.contextMaxCharacters != null
                ? { contextMaxCharacters: params.contextMaxCharacters as number }
                : {}),
            },
            {},
            signal,
          )
        }

        const output = result ?? 'No search results found. Please try a different query.'

        return {
          content: [{ type: 'text', text: output }],
          details: { query, provider, resultLength: output.length },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [
            {
              type: 'text',
              text: `Web search failed (${providerLabel}): ${message}`,
            },
          ],
          details: { error: true, query, provider, message },
        }
      }
    },
  })
}
