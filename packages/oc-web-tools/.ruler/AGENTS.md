# pi-oc-web-tools — Opencode-Inspired Web Fetch & Search

A Pi coding-agent extension that implements opencode-like web fetch and web search tools using MCP (Model Context Protocol) transport.

## Key Details

- **Tools**: `webfetch` (URL fetch + HTML→Markdown), `websearch` (MCP search via Exa/Parallel)
- **MCP Transport**: JSON-RPC 2.0 over HTTP with SSE streaming response parsing
- **HTML Processing**: Turndown for HTML→Markdown, regex-based tag-stripping for HTML→Text
## Key Decisions

- **Single-file extension**: All tools and MCP transport in `index.ts` for simplicity (matches oc-rewind/oc-todo pattern)
- **Turndown as dependency**: Listed in `package.json`; resolved by jiti via workspace hoisting
- **MCP without Effect**: Pi extensions use native `fetch()` instead of Effect's HttpClient; same JSON-RPC framing as opencode
- **No permission gates**: ACP clients can't handle interactive `ctx.ui.confirm()` prompts during tool execution
- **No SSE streaming to LLM**: Unlike opencode which streams live crawl progress, pi tools return results atomically
- **Provider auto-detection**: PARALLEL_API_KEY → Parallel; EXA_API_KEY → Exa; neither → Exa public tier

## Code Location

- Source: `packages/oc-web-tools/index.ts`
- Published as: `@touchtechclub/pi-oc-web-tools`
- License: MIT
