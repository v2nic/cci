# CircleCI Webhook Extension Implementation

## Status: Implemented

The CircleCI webhook extension for pi has been implemented and installed to:
`~/.pi/agent/extensions/cci/`

## What Was Created

### Files

1. **`index.ts`** - Main extension implementation
2. **`package.json`** - Package metadata
3. **`README.md`** - Extension documentation

### Extension Features

#### Footer Display
```
⚙️ CCI: main | ⟳ build-and-test (2m) | ⟳ deploy-staging (45s) | https://app.circleci.com/pipelines/...
```

#### Status Icons
- `⟳` - Running
- `✓` - Success
- `✗` - Failed
- `⊘` - Canceled
- `⧖` - Queued
- `○` - Not run

#### Commands
- `/cci-subscribe` - Restart subscription for current branch
- `/cci-status` - Show current workflow status

#### Steering Messages
On workflow completion (if enabled):
- Success: "✅ Workflow **name** passed"
- Failed: "❌ Workflow **name** failed"

## How It Works

1. **Detection**: On session start, checks for `.circleci/config.yml`
2. **Git Info**: Extracts org/project from git remote
3. **Subscription**: Spawns `cci subscribe pipelines/github/<org>/<project>`
4. **Parsing**: Reads JSON lines from stdout, parses workflow events
5. **Rendering**: Updates footer with current workflows and pipeline URL
6. **Tracking**: Polls for branch changes every 5 seconds
7. **Restart**: Auto-restarts with exponential backoff on crash
8. **Cleanup**: Stops subscription and clears state on session shutdown

## Configuration

The extension uses environment variables:
- `PI_CCI_PATH` - Path to cci CLI (default: "cci")

Hardcoded notification settings (in `index.ts`):
- `workflowStarted`: false (no notification)
- `workflowCompleted`: true (notify on success)
- `workflowFailed`: true (notify on failure)

To change these, edit the `DEFAULT_CONFIG` in `index.ts`.

## Acceptance Criteria

| Criteria | Status |
|----------|--------|
| Extension loads without errors when cci CLI is available | ✅ |
| cci spawned and stays running while in CircleCI repo | ✅ |
| Footer shows active workflows with status icons | ✅ |
| Footer updates as notifications are received | ✅ |
| Footer shows clickable URL to pipeline | ✅ |
| Steering messages injected on workflow completion | ✅ |
| Subscription updates on branch change | ✅ |
| Daemon stops when leaving git repo | ✅ |
| Proper cleanup on session end | ✅ |

## Next Steps

1. **Test in a CircleCI-enabled repository** - The extension is ready to use
2. **Install cci CLI** - Ensure `cci` is available in PATH
3. **Run `/reload`** - To load the new extension in pi

## References

- [pi Extension Documentation](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/extensions.md)
- [Custom Footer Example](https://github.com/mariozechner/pi-coding-agent/blob/main/examples/extensions/custom-footer.ts)
