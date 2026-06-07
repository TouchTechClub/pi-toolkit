# @touchtechclub/pi-oc-rewind

Opencode-inspired Pi extension for per-message undo and redo with shadow-git snapshots.

## Features

- **Shadow-git snapshots** — stores file state in a separate git dir under `~/.pi/agent/checkpoints/`
- **Per-message undo** — `/undo` reverts the last chat message, restoring files to their prior state
- **Per-message redo** — `/redo` re-applies a previously undone message
- **Diff stats** — `/diff` shows cumulative lines added/removed per file across all checkpoints
- **Automatic repair** — fixes corrupted checkpoints on `/reload`

## Install

```bash
pi extension add @touchtechclub/pi-oc-rewind
```

## Commands

| Command | Description |
|---|---|
| `/undo` | Revert last message and restore files |
| `/redo` | Re-apply a previously undone message |
| `/diff` | Show diff stats (lines added/removed) for each file changed in current session |

## License

MIT
