# CCI Architecture

## System Overview

CCI consists of two main components:

1. **CLI + Daemon**: A Bun-based CLI tool with a persistent daemon process
2. **pi Agent Extension**: A TypeScript extension that subscribes to CI events and displays status in the terminal footer

```
┌─────────────────────────────────────────────────────────────────┐
│                         pi Agent                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              CCI Extension (TypeScript)                  │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐   │    │
│  │  │ Subscription│  │  Footer     │  │ Notifications│   │    │
│  │  │  Manager    │  │  Renderer   │  │   Handler    │   │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘   │    │
│  └─────────┼────────────────┼───────────────┼────────────┘    │
│            │                │               │                  │
└────────────┼────────────────┼───────────────┼──────────────────┘
             │                │               │
             │  spawn/kill    │               │
             ▼                │               │
┌─────────────────────────────────────────────────────────────────┐
│                      Terminal/Shell                              │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              cci CLI (compiled Bun binary)               │    │
│  │  ┌─────────────┐  ┌─────────────────────────────────┐  │    │
│  │  │  Subscribe  │──│  WebSocket to Daemon            │  │    │
│  │  │  Command    │  │                                 │  │    │
│  │  └─────────────┘  └─────────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
             │
             │ HTTP/WebSocket
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   CCI Daemon (Bun Server)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐    │
│  │ WebSocket   │  │  HTTP API   │  │   CircleCI Client   │    │
│  │  Handler    │  │  (health,   │──│                     │    │
│  │             │  │   login)    │  │   GET /me/collabor  │    │
│  └──────┬──────┘  └─────────────┘  │   GET /pipeline/... │    │
│         │                          └─────────────────────┘    │
│         │                                                        │
│  ┌──────▼──────────────────────────────────────────────┐        │
│  │              Event Publisher                         │        │
│  │  - Maintains last state per pipeline                │        │
│  │  - Publishes only on state changes                 │        │
│  │  - Marks initial events with isLatest: true        │        │
│  └────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
             │
             │ Polling
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     CircleCI API                                 │
│              https://circleci.com/api/v2                         │
└─────────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. CCI Daemon (`src/daemon.ts`)

The daemon is a Bun HTTP/WebSocket server that:
- Maintains subscriptions by WebSocket connection
- Polls CircleCI API at configured intervals
- Publishes state changes to all connected subscribers
- Supports `--include-latest` flag for initial state delivery

**State Management:**
```typescript
interface DaemonState {
  token: string | null;
  subscriptionsBySocket: Map<string, Set<string>>;
  socketTargets: Map<string, SubscriptionTarget[]>;
  lastStateByPipeline: Map<string, string>;  // Pipeline state cache
  includeLatest: boolean;                   // Send initial state
  initialLatestSent: boolean;                // Track if initial state sent
  server?: Bun.Server<SocketData>;
}
```

**Socket Data:**
```typescript
interface SocketData {
  id: string;
  includeLatest: boolean;
}
```

**Polling Logic:**
1. On `subscribe` message with `--include-latest`:
   - Set `state.includeLatest = true`
   - Set `state.initialLatestSent = false`
2. On each poll cycle:
   - If `includeLatest && !initialLatestSent`, mark events as `isLatest: true`
   - After first poll, set `initialLatestSent = true` and `includeLatest = false`
   - Skip events where state hasn't changed (unless `isLatest`)

### 2. CLI (`src/cli.ts`)

The CLI spawns the daemon if needed and communicates via WebSocket:

**Subscribe Flow:**
```
1. Check if daemon is healthy (GET /health)
2. If not, spawn daemon (bun --daemon)
3. Wait for daemon to be healthy
4. Connect WebSocket to ws://localhost:4847/ws
5. Send subscribe message with targets and includeLatest flag
6. Stream JSON events from daemon to stdout
```

**Message Format:**
```json
{
  "type": "subscribe",
  "targets": ["pipelines/github/org/project"],
  "includeLatest": true
}
```

### 3. Types (`src/types.ts`)

**Stream Event (with isLatest):**
```typescript
interface StreamEvent {
  id: string;
  timestamp: string;
  project: string;
  pipelineNumber: number;
  eventType: AggregateStatus;
  icon: string;
  description: string;
  circleCiUrl: string;
  target: string;
  isLatest?: boolean;  // True for initial/latest status
}
```

**Aggregate Status:**
```typescript
type AggregateStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'on_hold'
  | 'not_run'
  | 'unauthorized'
  | 'canceled'
  | 'error'
  | 'unknown';
```

### 4. pi Extension (`~/.pi/agent/extensions/cci/index.ts`)

The extension uses `ctx.ui.setFooter()` to render a custom footer:

**Footer Rendering:**
```typescript
ctx.ui.setFooter((tui, theme, footerData) => {
  return {
    render(width: number): string[] {
      return [
        theme.fg("dim", pwd + " • " + branch),           // Line 1: PWD
        theme.fg("dim", tokenStats + " " + modelId),     // Line 2: Tokens
        theme.fg("dim", otherExtensionStatuses),        // Line 3: Other extensions
        theme.fg("dim", buildCciStatus()),               // Line 4: CCI status
      ];
    }
  };
});
```

**Event Handling:**
- Distinguishes `isLatest` events from real updates
- Only triggers steering notifications for non-latest events
- Maintains `lastPipeline` state for showing recent status
- Updates `workflows` Map for running workflows

**Event Parsing:**
```typescript
// Daemon stream events (have eventType)
if ("eventType" in parsed) {
  handleStreamEvent(parsed as StreamEvent);
}
// Raw CircleCI events (have type)
else if ("type" in parsed) {
  handleWorkflowEvent(parsed as CciWorkflowEvent);
}
```

## Data Flow

### Initial Subscription Flow

```
pi Extension                    cci CLI                      Daemon
     │                            │                            │
     │ spawn("cci subscribe",     │                            │
     │   ["--include-latest"])    │                            │
     │───────────────────────────►│                            │
     │                            │ GET /health                │
     │                            │───────────────────────────►│
     │                            │ { ok: true }               │
     │                            │◄───────────────────────────│
     │                            │                            │
     │                            │ WS connect                 │
     │                            │───────────────────────────►│
     │                            │                            │
     │                            │ {"type":"subscribe",       │
     │                            │  "targets":[...],          │
     │                            │  "includeLatest":true}     │
     │                            │───────────────────────────►│
     │                            │                            │
     │                            │◄───────────────────────────│
     │ {"subscribed"}             │ {"subscribed"}            │
     │◄──────────────────────────│                            │
     │                            │                            │
     │                            │◄───────────────────────────│
     │ {"isLatest":true,          │ {pipeline:{"id":"...}},   │
     │  "eventType":"failed"}     │ isLatest:true             │
     │◄───────────────────────────│  (NO STEERING)            │
     │                            │                            │
     │                            │◄───────────────────────────│
     │ {"isLatest":false,         │ {pipeline:{"id":"..."}},  │
     │  "eventType":"success"}    │ isLatest:false            │
     │◄───────────────────────────│  (TRIGGERS STEERING)      │
     │                            │                            │
```

### Footer Update Flow

```
CircleCI API              Daemon              Extension              TUI
    │                       │                    │                   │
    │ Poll: #2072 failed    │                    │                   │
    │──────────────────────►│                    │                   │
    │                       │                    │                   │
    │                       │ State changed      │                   │
    │                       │ publish(event)     │                   │
    │                       │───────────────────►│                   │
    │                       │                    │                   │
    │                       │                    │ update lastPipeline│
    │                       │                    │──────────────────►│
    │                       │                    │                   │
    │                       │                    │ requestRender()   │
    │                       │                    │◄──────────────────│
    │                       │                    │                   │
    │                       │                    │                   │ Footer
    │                       │                    │                   │ redraws
```

## Configuration

### Extension Config
```typescript
interface CciConfig {
  path: string;              // Path to cci binary ("cci" or "/path/to/cci")
  notifications: {
    workflowStarted: boolean;   // Notify on workflow start
    workflowCompleted: boolean; // Notify on success
    workflowFailed: boolean;    // Notify on failure
  };
}
```

### Default Values
```typescript
const DEFAULT_CONFIG: CciConfig = {
  path: "cci",
  notifications: {
    workflowStarted: false,
    workflowCompleted: true,
    workflowFailed: true,
  },
};
```

## Error States

| State | Cause | Footer Message | Retry |
|-------|-------|----------------|-------|
| `not_installed` | `cci` not in PATH | `⛔ cci CLI not found` | No |
| `not_circleci` | No `.circleci/config.yml` | `○ Not a CircleCI repo` | No |
| `no_remote` | No git remote | `○ No git remote` | No |
| `error` | Connection/other failure | `⛔ <message>` | Yes (max 3) |

## Retry Logic

```typescript
// Exponential backoff: 2s, 4s, 8s
const delay = 1000 * Math.pow(2, restartAttempts);
restartAttempts++;

// After 3 attempts, give up
if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
  setState("error", `Max retries (${MAX_RESTART_ATTEMPTS}) exceeded`);
}
```

## File Structure

```
~/Source/v2nic-cci/first-version/
├── src/
│   ├── index.ts           # Entry point (CLI or Daemon)
│   ├── cli.ts             # CLI commands (subscribe, login, etc.)
│   ├── daemon.ts          # WebSocket/HTTP server
│   ├── circleci.ts        # CircleCI API client
│   ├── config.ts          # Configuration (ports, timeouts)
│   ├── targets.ts         # Target parsing/formatting
│   ├── token-store.ts     # Token file management
│   ├── types.ts           # TypeScript interfaces
│   ├── web.ts             # HTML web interface
│   └── web.tsx            # Web UI components
├── dist/
│   └── cci                # Compiled binary
└── REQUIREMENTS.md        # This document
```

## Installation Paths

### Production
```bash
install -m 0755 ./dist/cci /usr/local/bin/cci
```

### Development (user-local)
```bash
mkdir -p ~/bin
install -m 0755 ./dist/cci ~/bin/cci
# Add to ~/.zshenv: export PATH="$HOME/bin:$PATH"
```
