# pi-toolkit Monorepo

A monorepo for Pi coding-agent tooling managed with Bun and Biome. Contains the pi-acp ACP adapter and Pi extensions.

## General Guidelines

- **Package manager**: Bun (`bun install`, `bun run ...`)
- **Formatter/Linter**: Biome (`biome format --write .`, `biome lint .`)
- **TypeScript**: strict mode where practical, prefer explicit types over `any`
- **Testing**: Bun's built-in test runner (`bun test`)
- **Comments**: Use sparingly — explain non-obvious decisions, don't narrate code
- **Format before finish**: Run `bun run format` after code changes
- **DO NOT commit** unless explicitly asked
- **Licensing**: MIT — maintain copyright attribution for upstream projects

## Build Pipeline

```bash
bun run typecheck    # tsc --noEmit (pi-acp only)
bun run test         #  bun test (pi-acp only)
bun run build        # tsup (pi-acp only)
bun run format       # biome format --write .
bun run lint         # biome lint .
```

## Publishing

Push to the `release` branch with a version bump in a package's `package.json`. The GitHub workflow auto-publishes changed packages.

## Ruler

This repo uses [ruler](https://github.com/intellectronica/ruler) to manage AI agent instructions. Rules live in `.ruler/` directories; run `bun run ruler apply --nested` to regenerate agent config files (AGENTS.md, CLAUDE.md, etc.).

See the package-level `.ruler/` directories for package-specific context.
