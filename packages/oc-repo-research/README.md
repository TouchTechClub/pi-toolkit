# @touchtechclub/pi-oc-repo-research

Opencode-inspired Pi extension providing git repository cloning, overview tools, and configurable project references for agent research.

## Features

- **Project references** — Configure local directories and git repos as named references in `.pi/settings.json`, with autocomplete and agent context injection
- **`repo_clone`** — Clone any git repository into a managed local cache, with optional refresh and branch selection
- **`repo_overview`** — Inspect a cached or local repository's structure, detect ecosystems, dependency files, and entrypoints
- **`/repos`** — Manage the repository cache (list, delete)

## Install

### Local linking (development)

```bash
# In pi-toolkit root:
bun install
```

Then add to `.pi/settings.json`:

```json
{
  "packages": ["../packages/oc-repo-research"]
}
```

### From npm

```bash
pi extension add @touchtechclub/pi-oc-repo-research
```

## Configuration

### References

Define project references in `.pi/settings.json` (or `~/.pi/agent/settings.json` for global):

```jsonc
{
  "references": {
    "sdk": {
      "repository": "anomalyco/opencode-sdk-js",
      "branch": "main",
      "description": "Use for JavaScript SDK implementation details"
    },
    "docs": {
      "path": "../product-docs",
      "description": "Use for product behavior and documentation conventions"
    },
    "internal": {
      "path": "../internal",
      "description": "Internal implementation details",
      "hidden": true
    }
  }
}
```

**String shorthand** (when you don't need branch or other options):

```jsonc
{
  "references": {
    "docs": "../docs",
    "effect": "Effect-TS/effect"
  }
}
```

| Field | Local | Git | Description |
|---|---|---|---|
| `path` | Yes | No | Local reference directory (relative to config, absolute, or `~`) |
| `repository` | No | Yes | Git URL, host/path, or GitHub `owner/repo` shorthand |
| `branch` | No | Yes | Optional Git branch or ref |
| `description` | Yes | Yes | Guidance describing when the agent should use the reference |
| `hidden` | Yes | Yes | Hide the reference from `@` autocomplete in TUI |

References are loaded on session start and:
- **Git references** are auto-cloned/refreshed into `~/.pi/agent/repos/`
- **References with descriptions** are injected into the agent's system prompt automatically
- **`@alias` autocomplete** is available in the TUI for non-hidden references

### Environment

| Variable | Description | Default |
|---|---|---|
| `OPENCODE_REPO_CLONE_GITHUB_BASE_URL` | Override GitHub clone base URL | `https://github.com/` |

## Tools

### repo_clone

Clones a git repository into a managed local cache directory (`~/.pi/agent/repos/`). Supports GitHub owner/repo shorthand, full URLs, and SCP-style references.

| Parameter | Type | Description |
|---|---|---|
| `repository` | string | Repository to clone (URL, host/path, or owner/repo shorthand) |
| `refresh` | boolean? | When true, fetches latest remote state into cache |
| `branch` | string? | Branch or ref to clone and inspect |

### repo_overview

Inspects the directory structure of a cloned or local repository. Detects language ecosystems, package managers, dependency files, and likely entrypoints.

| Parameter | Type | Description |
|---|---|---|
| `repository` | string? | Cached repository to inspect (use repo_clone first) |
| `path` | string? | Directory path to inspect instead of a cached repository |
| `depth` | number? | Maximum directory tree depth (default: 3, range: 1–6) |

## License

MIT
