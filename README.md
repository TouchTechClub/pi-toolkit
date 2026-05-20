# pi-toolkit

Monorepo for Pi coding agent tooling. Managed with [Bun](https://bun.sh) and [Biome](https://biomejs.dev).

## Packages

| Package | Description |
|---|---|
| [`acp`](./packages/acp) | ACP adapter — bridges Pi sessions into Agent Client Protocol clients (Zed, etc.) |
| [`oc-todo`](./packages/oc-todo) | Pi extension — structured todo list tracking, ACP plan-compatible |
| [`oc-rewind`](./packages/oc-rewind) | Pi extension — per-message undo/redo with shadow-git snapshots |

## Scripts

```bash
bun run build        # Build pi-acp
bun run typecheck    # Type-check pi-acp
bun run test         # Run pi-acp tests
bun run format       # Format all packages with Biome
bun run lint         # Lint all packages with Biome
```

## Publishing

Push to `main` with a version bump in a package's `package.json`. The [publish workflow](./.github/workflows/publish.yml) detects changed packages with version bumps and publishes them to npm automatically.

## License

MIT
