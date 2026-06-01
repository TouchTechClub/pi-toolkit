# pi-toolkit

Monorepo for Pi coding agent tooling. Managed with [Bun](https://bun.sh) and [Biome](https://biomejs.dev).

## Packages

| Package | Description |
|---|---|
| [`acp`](./packages/acp/README.md) | ACP adapter — bridges Pi sessions into Agent Client Protocol clients (Zed, etc.) |
| [`oc-repo-research`](./packages/oc-repo-research/README.md) | Pi extension — git repository cloning and overview tools for agent research |
| [`oc-rewind`](./packages/oc-rewind/README.md) | Pi extension — per-message undo/redo with shadow-git snapshots |
| [`oc-todo`](./packages/oc-todo/README.md) | Pi extension — structured todo list tracking, ACP plan-compatible |
| [`oc-web-tools`](./packages/oc-web-tools/README.md) | Pi extension — web fetch and search tools with MCP transport |

## Scripts

```bash
bun run build        # Build pi-acp (packages/acp only)
bun run typecheck    # Type-check pi-acp (packages/acp only)
bun run test         # Run pi-acp tests (packages/acp only)
bun run format       # Format all packages with Biome
bun run lint         # Lint all packages with Biome
bun run check        # Check all packages with Biome (format + lint)
```

## Publishing

Push to `main` with a version bump in a package's `package.json`. The [publish workflow](./.github/workflows/publish.yml) detects changed packages with version bumps and publishes them to npm automatically.

## License

MIT
