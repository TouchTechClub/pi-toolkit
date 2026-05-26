# @touchtechclub/pi-oc-web-tools

Opencode-inspired Pi extension providing web fetch and web search tools with MCP transport.

## Features

- **`webfetch`** — Fetch and convert web page content to markdown, plain text, or raw HTML
- **`websearch`** — Search the web using MCP-based providers (Exa, Parallel)
- **MCP JSON-RPC transport** — Low-level SSE/JSON response parsing for search providers
- **Turndown integration** — HTML to Markdown conversion for readable output
- **Redirect handling** — Automatic retry on Cloudflare bot-detection challenges

## Install

### Local linking (development)

```bash
# In pi-toolkit root:
bun install
```

Then add to `.pi/settings.json`:

```json
{
  "packages": ["../packages/oc-web-tools"]
}
```

### From npm

```bash
pi extension add @touchtechclub/pi-oc-web-tools
```

## Configuration

| Variable | Description |
|---|---|
| `EXA_API_KEY` | Exa search API key (appended to MCP URL) |
| `PARALLEL_API_KEY` | Parallel search API key (Bearer auth) |
| `OC_WEBSEARCH_PROVIDER` | Override provider: `exa` or `parallel` |

If neither API key is set, Exa's public tier is used as fallback.

## Tools

### webfetch

Fetches a URL and returns content in the specified format.

| Parameter | Type | Description |
|---|---|---|
| `url` | string | URL to fetch (must start with http:// or https://) |
| `format` | "markdown" \| "text" \| "html" | Output format (default: markdown) |
| `timeout` | number? | Timeout in seconds (max 120, default 30) |

### websearch

Searches the web via MCP-based search providers.

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Search query |
| `numResults` | number? | Results to return (default: 8) |
| `livecrawl` | "fallback" \| "preferred"? | Live crawl mode |
| `type` | "auto" \| "fast" \| "deep"? | Search type |
| `contextMaxCharacters` | number? | Max chars for context string |

## License

MIT
