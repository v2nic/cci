# CCI Requirements

## Overview

CCI (CircleCI CLI) is a Bun-based CLI tool for interacting with CircleCI, featuring a WebSocket-backed JSONL event stream subscription system.

## CircleCI Webhook Extension for pi Agent

### Goal
Provide real-time CI status in the pi agent's terminal footer, showing CircleCI workflow status for the current git branch.

### Functional Requirements

#### Footer Display
- Show CI status in a dedicated line at the bottom of the terminal
- Display branch name being tracked
- Show workflow status icons:
  - `⟳` - running
  - `✓` - success
  - `✗` - failed
  - `⊘` - canceled
  - `⧖` - queued
  - `○` - not_run
- Show running workflows with duration (e.g., `⟳ build (2m)`)
- Show completed workflows with relative time (e.g., `✓ build (5m ago)`)
- When no workflows running, show last pipeline status with time (e.g., `✗ last: 35m ago`)
- Footer preserves default content (pwd, branch, session name, token stats)

#### Subscription Behavior
- Subscribe to pipelines for the current git branch
- Use `--include-latest` flag to receive current status on subscribe
- Initial/latest status events MUST NOT trigger agent steering
- Only real-time updates should trigger notifications
- Mark initial status events with `isLatest: true` field

#### Notifications
- Send steering messages for workflow status changes (success/failure)
- Include CircleCI pipeline URL in notification messages
- Allow configuration of notification preferences

#### Error Handling
- Gracefully handle ENOENT (CCI not installed) - show `⛔ cci CLI not found`
- Handle non-CircleCI repos - show `○ Not a CircleCI repo`
- Handle missing git remote - show `○ No git remote`
- Implement exponential backoff for reconnection (2s, 4s, 8s)
- Limit restart attempts to 3 before giving up
- Terminal states (not_installed, not_circleci, no_remote) should not retry
- Suppress stderr output to avoid polluting the session

#### Branch Tracking
- Track current git branch
- Automatically resubscribe when branch changes
- Detect detached HEAD state

### CLI Requirements

#### `cci subscribe` Command
- Accept `--include-latest` flag
- When flag is set, daemon sends current pipeline status on subscribe
- Initial events marked with `isLatest: true`

Example:
```bash
cci subscribe pipelines/github/<org>/<project> --include-latest
```

#### Stream Event Format
Events include `isLatest` field:
```json
{
  "id": "gh/org/project:123:running",
  "timestamp": "2026-03-20T21:22:11.182Z",
  "project": "org/project",
  "pipelineNumber": 123,
  "eventType": "running",
  "icon": "⏳",
  "description": "Pipeline #123 is running (default:running)",
  "circleCiUrl": "https://app.circleci.com/pipelines/github/org/project/123",
  "target": "pipelines/github/org/project",
  "isLatest": true
}
```

## Installation

### CCI CLI Installation
- Binary should be installable to `/usr/local/bin/cci`
- Or installed to `~/bin/cci` with `~/bin` in PATH
- Detect token file at `~/.circleci/token`

### Extension Installation
- pi agent extension installed to `~/.pi/agent/extensions/cci/`
- Requires `/reload` to activate after changes
