# @touchtechclub/pi-oc-repo-research

Opencode-inspired Pi extension providing git repository cloning and overview tools for agent research.

## Features

- **`repo_clone`** — Clone any git repository into a managed local cache, with optional refresh and branch selection
- **`repo_overview`** — Inspect a cached or local repository's structure, detect ecosystems, dependency files, and entrypoints

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
