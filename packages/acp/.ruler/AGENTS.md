# pi-acp — ACP Adapter for Pi

This package is a maintained clone of [`svkozak/pi-acp`](https://github.com/svkozak/pi-acp), originally by Sergii Kozak. Keep attribution to the upstream project when changing docs or metadata.

Implements an **Agent Client Protocol (ACP)** adapter for **pi** (`@earendil-works/pi-coding-agent`) without modifying pi.

## Architecture

- ACP side: **JSON-RPC 2.0 over stdio** using `@agentclientprotocol/sdk` (TypeScript)
- Pi side: spawn `pi --mode rpc` and communicate via **newline-delimited JSON** over stdio
- 1 ACP session ↔ 1 pi subprocess

## Key Source Files

| File | Purpose |
|---|---|
| `src/acp/agent.ts` | Main ACP agent — session lifecycle, command handling, history loading |
| `src/acp/session.ts` | Live session — event streaming, tool diffs, plan updates |
| `src/acp/pi-commands.ts` | Extension command advertisement + ACP compatibility filtering |
| `src/acp/translate/pi-todos.ts` | `todowrite` extension → ACP `plan` session update |
| `src/acp/translate/pi-tools.ts` | Shared utility: tool titles, bash command extraction |
| `src/pi-rpc/command.ts` | Pi subprocess spawn + command dispatch |
| `src/pi-rpc/process.ts` | Pi RPC process lifecycle (JSON-over-stdio) |

## Key Decisions

- **ACP extension compatibility is source-comment-only**: Only `// @pi-acp-compatible` is accepted for extension command advertisement; metadata/exports are ignored.
- **Incompatible extension commands**: Invoking an incompatible command returns `The /command extension command is not marked ACP-compatible.` and emits an `end_turn`.
- **ACP-compatible extension commands** execute via direct RPC (outside the normal agent loop) and emit `Ran /cmd.` followed by `end_turn`.
- **Bash tool titles** update from generic `bash` to `bash <command>` when execution args arrive via `tool_execution_start`.
- **Edit diffs** use relative paths (matching original `svkozak/pi-acp` behavior).
- **Todo plan translation**: `todowrite` extension results are mapped to ACP `sessionUpdate: "plan"` with `PlanEntry[]` items.

## Dev Workflow

```bash
cd packages/pi-acp
bun install
bun run dev         # tsx src/index.ts
bun run build       # tsup
bun run typecheck   # tsc --noEmit
bun run test        # bun test (72 tests)
bun run lint        # biome lint .
bun run format      # biome format --write .
```

## Testing

- Unit tests: `test/unit/` — fast, isolated
- Component tests: `test/component/` — simulate pi RPC events against `PiAcpSession`
- Helpers: `test/helpers/fakes.ts` — `FakeAgentSideConnection`, `FakePiRpcProcess`
- Skip: 2 Windows-only platform tests (`defaultPiCommand`, `shouldUseShellForPiCommand`)

## Client Info

- Current ACP client is **Zed**
- Local Zed config: `~/.config/zed/settings.json`
- Local ACP agent entry: `touchtech-pi-acp-local`
