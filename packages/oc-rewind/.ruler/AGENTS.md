# pi-oc-rewind — Opencode-Inspired Undo/Redo

A Pi coding-agent extension that implements opencode-like per-message undo and redo using shadow-git snapshots.

## Key Details

- **Commands**: `/undo`, `/redo`, `/acp-undo`, `/acp-redo`, `/checkpoint-undo`, `/checkpoint-redo`
- **ACP-compatible**: Marked with `// @pi-acp-compatible`
- **Storage**: Shadow git dir at `~/.pi/agent/checkpoints/`
- **Model**: Uses Pi session tree navigation — undo navigates to `beforeLeafId`, redo navigates to `finalLeafId`

## Key Decisions

- **Capture checkpoint on assistant `message_start`**: `before_agent_start` and `turn_start` were too early/incorrect for reliable user-entry binding.
- **Bind checkpoint by prompt text**: Prevents checkpointing previous user message when current user entry is not visible.
- **Repair bad checkpoints on reload**: Existing sessions may contain corrupted metadata from earlier versions.
- **ACP-friendly aliases**: `/acp-undo` and `/acp-redo` avoid collisions with client-native undo/redo actions.

## Code Location

- Source: `packages/oc-rewind/index.ts`
- Published as: `@touchtechclub/pi-oc-rewind`
- License: MIT
