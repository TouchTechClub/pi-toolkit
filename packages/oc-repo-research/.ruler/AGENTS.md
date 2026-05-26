# oc-repo-research

Pi extension providing git repository cloning and overview tools, inspired by opencode.

## Behavior

- Registers two tools: `repo_clone` and `repo_overview`
- `repo_clone` clones remote git repos into `~/.pi/agent/repos/` with optional refresh and branch support
- `repo_overview` inspects directory structure, detects ecosystems, dependency files, and entrypoints
- Repository references support GitHub shorthand (`owner/repo`), full URLs, and SCP-style
- Git commands use `child_process.execFile` with 2-minute timeout and 10MB output buffer
- Follows existing patterns from `oc-web-tools` and `oc-todo` packages
