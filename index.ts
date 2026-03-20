/**
 * CircleCI Webhook Extension for pi
 *
 * Provides real-time CI status in the footer, showing each workflow
 * currently running for the tracked remote branch with links to open
 * in CircleCI.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Types for CircleCI subscription events
interface CciWorkflowEvent {
  type: "workflow-completed" | "workflow-started" | "job-completed" | "job-started";
  timestamp: number;
  pipeline: {
    id: string;
    number: number;
    project_slug: string;
  };
  workflow: {
    id: string;
    name: string;
    status: string;
    started_at: string;
  };
  job?: {
    id: string;
    name: string;
    status: string;
  };
}

// Parsed workflow for display
interface Workflow {
  id: string;
  name: string;
  status: "running" | "success" | "failed" | "canceled" | "queued" | "not_run";
  startedAt: Date;
  pipelineUrl: string;
}

// Configuration
interface CciConfig {
  path: string;
  notifications: {
    workflowStarted: boolean;
    workflowCompleted: boolean;
    workflowFailed: boolean;
  };
}

const DEFAULT_CONFIG: CciConfig = {
  path: "cci",
  notifications: {
    workflowStarted: false,
    workflowCompleted: true,
    workflowFailed: true,
  },
};

const STATUS_ICONS: Record<string, string> = {
  running: "⟳",
  success: "✓",
  failed: "✗",
  canceled: "⊘",
  queued: "⧖",
  not_run: "○",
};

type ExtensionState = "idle" | "checking" | "subscribed" | "error" | "not_installed" | "not_circleci" | "no_remote";

export default function (pi: ExtensionAPI) {
  let cciProcess: ChildProcess | null = null;
  let workflows: Map<string, Workflow> = new Map();
  let currentBranch: string | null = null;
  let currentOrg: string | null = null;
  let currentProject: string | null = null;
  let currentPipelineUrl: string | null = null;
  let restartTimeout: ReturnType<typeof setTimeout> | null = null;
  let restartAttempts = 0;
  let extensionState: ExtensionState = "idle";
  let errorMessage: string = "";
  let isRestarting = false;

  const config = loadConfig();
  const cciPath = config.path;
  const notifications = config.notifications;

  // Maximum restart attempts before giving up
  const MAX_RESTART_ATTEMPTS = 3;

  // Status key for setStatus
  const STATUS_KEY = "cci";

  // Load configuration from settings
  function loadConfig(): CciConfig {
    try {
      const settingsPath = join(process.env.HOME || "", ".pi", "agent", "settings.json");
      return DEFAULT_CONFIG;
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  // Update the status text in the footer
  function updateStatus(): void {
    const branch = currentBranch || "unknown";

    let statusText: string;

    // Handle different states
    if (extensionState === "not_installed") {
      statusText = `CCI: ${branch} | ⛔ cci CLI not found`;
    } else if (extensionState === "not_circleci") {
      statusText = `CCI: ${branch} | ○ Not a CircleCI repo`;
    } else if (extensionState === "no_remote") {
      statusText = `CCI: ${branch} | ○ No git remote`;
    } else if (extensionState === "error") {
      statusText = `CCI: ${branch} | ⛔ ${errorMessage}`;
    } else if (extensionState === "checking" || isRestarting) {
      statusText = `CCI: ${branch} | ◌ Connecting`;
    } else if (extensionState === "subscribed") {
      // Build workflow status
      const workflowParts: string[] = [];
      for (const wf of workflows.values()) {
        const icon = STATUS_ICONS[wf.status] || "?";
        if (wf.status === "running") {
          const elapsed = formatDuration(wf.startedAt);
          workflowParts.push(`${icon} ${wf.name} (${elapsed})`);
        } else {
          workflowParts.push(`${icon} ${wf.name}`);
        }
      }

      if (workflowParts.length > 0) {
        statusText = `CCI: ${branch} | ${workflowParts.join(" | ")}`;
      } else if (currentPipelineUrl) {
        statusText = `CCI: ${branch} | idle`;
      } else {
        statusText = `CCI: ${branch}`;
      }
    } else {
      statusText = `CCI: ${branch}`;
    }

    pi.emit("status_update", statusText);
  }

  // Emit status update via the events system
  pi.events.on("status_update" as any, (statusText: string) => {
    // This won't work directly - we need to use ctx.ui.setStatus
    // But we don't have ctx here, so we'll handle this differently
  });

  // Check if .circleci/config.yml exists
  async function isCircleCIEnabled(cwd: string): Promise<boolean> {
    try {
      const configPath = join(cwd, ".circleci", "config.yml");
      await access(configPath);
      return true;
    } catch {
      return false;
    }
  }

  // Get git remote info
  async function getGitRemote(cwd: string): Promise<{ org: string; project: string } | null> {
    try {
      const { stdout } = await execAsync("git remote get-url origin", { cwd });
      const url = stdout.trim();

      // Parse GitHub URL: git@github.com:org/project.git or https://github.com/org/project
      const gitMatch = url.match(/git@github\.com:(.+?)\/(.+?)(?:\.git)?$/);
      const httpsMatch = url.match(/https?:\/\/github\.com\/(.+?)\/(.+?)(?:\.git)?$/);

      if (gitMatch) {
        return { org: gitMatch[1], project: gitMatch[2] };
      }
      if (httpsMatch) {
        return { org: httpsMatch[1], project: httpsMatch[2] };
      }
      return null;
    } catch {
      return null;
    }
  }

  // Get current git branch
  async function getGitBranch(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync("git branch --show-current", { cwd });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  // Check if cci CLI is available
  async function isCciAvailable(): Promise<boolean> {
    try {
      await execAsync(`which ${cciPath}`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  // Parse workflow status to our type
  function parseStatus(
    status: string
  ): "running" | "success" | "failed" | "canceled" | "queued" | "not_run" {
    const lower = status.toLowerCase();
    if (lower === "running" || lower === "not_run") return lower as "running" | "not_run";
    if (lower === "success" || lower === "passed") return "success";
    if (lower === "failed" || lower === "failure") return "failed";
    if (lower === "canceled" || lower === "cancelled") return "canceled";
    if (lower === "queued") return "queued";
    return "running";
  }

  // Format duration
  function formatDuration(startedAt: Date): string {
    const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  // Set extension state and update status
  function setState(state: ExtensionState, message: string = ""): void {
    extensionState = state;
    errorMessage = message;
  }

  // Start cci subscribe process
  async function startSubscription(cwd: string): Promise<void> {
    // Stop any existing subscription
    stopSubscription();

    setState("checking");

    // Check if CircleCI is enabled
    if (!(await isCircleCIEnabled(cwd))) {
      setState("not_circleci");
      return;
    }

    // Get git remote
    const remote = await getGitRemote(cwd);
    if (!remote) {
      setState("no_remote");
      return;
    }

    // Check if cci CLI is available
    if (!(await isCciAvailable())) {
      setState("not_installed");
      return;
    }

    currentOrg = remote.org;
    currentProject = remote.project;
    currentPipelineUrl = `https://app.circleci.com/pipelines/${remote.org}/${remote.project}`;

    // Get branch
    currentBranch = await getGitBranch(cwd);
    if (!currentBranch || currentBranch === "(detached)") {
      setState("error", "Detached HEAD");
      return;
    }

    setState("checking");

    // Spawn cci subscribe process
    const subscribeTarget = `pipelines/github/${currentOrg}/${currentProject}`;
    try {
      cciProcess = spawn(cciPath, ["subscribe", subscribeTarget], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err: unknown) {
      const error = err as Error;
      if (error.message?.includes("ENOENT")) {
        setState("not_installed");
        return;
      }
      setState("error", "Failed to start");
      return;
    }

    if (!cciProcess.stdout || !cciProcess.stderr) {
      setState("error", "Failed to get streams");
      return;
    }

    // Handle stdout - parse JSON lines
    let buffer = "";
    cciProcess.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CciWorkflowEvent;
          handleWorkflowEvent(event);
        } catch (e) {
          // Ignore parse errors for non-JSON output
        }
      }
    });

    // Only log stderr at debug level, don't spam the session
    cciProcess.stderr.on("data", (data: Buffer) => {
      // Silently ignore stderr to avoid polluting the session
    });

    cciProcess.on("error", (err: Error) => {
      if (err.message.includes("ENOENT")) {
        setState("not_installed");
        return;
      }
      // Log error once, then schedule restart
      if (restartAttempts === 0) {
        setState("error", "Connection failed");
      }
      scheduleRestart(cwd);
    });

    cciProcess.on("exit", (code: number | null) => {
      if (extensionState === "not_installed" || extensionState === "not_circleci" || extensionState === "no_remote") {
        // Terminal states - don't restart
        return;
      }

      if (code !== 0 && code !== null && !isRestarting) {
        scheduleRestart(cwd);
      }
    });

    restartAttempts = 0;
    setState("subscribed");
  }

  // Stop cci subscribe process
  function stopSubscription(): void {
    isRestarting = false;

    if (restartTimeout) {
      clearTimeout(restartTimeout);
      restartTimeout = null;
    }

    if (cciProcess) {
      cciProcess.kill("SIGTERM");
      cciProcess = null;
    }

    workflows.clear();
  }

  // Schedule restart with exponential backoff
  function scheduleRestart(cwd: string): void {
    // Don't restart if in a terminal error state
    if (extensionState === "not_installed" || extensionState === "not_circleci" || extensionState === "no_remote") {
      return;
    }

    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      setState("error", `Max retries (${MAX_RESTART_ATTEMPTS}) exceeded`);
      isRestarting = false;
      return;
    }

    isRestarting = true;

    // Exponential backoff: 2s, 4s, 8s
    const delay = 1000 * Math.pow(2, restartAttempts);
    restartAttempts++;

    restartTimeout = setTimeout(() => {
      startSubscription(cwd);
    }, delay);
  }

  // Handle workflow events
  function handleWorkflowEvent(event: CciWorkflowEvent): void {
    const { type, workflow, pipeline } = event;

    if (type === "workflow-started") {
      const wf: Workflow = {
        id: workflow.id,
        name: workflow.name,
        status: parseStatus(workflow.status),
        startedAt: new Date(workflow.started_at || Date.now()),
        pipelineUrl: `https://app.circleci.com/pipelines/${pipeline.project_slug}/${pipeline.number}`,
      };
      workflows.set(workflow.id, wf);

      if (notifications.workflowStarted) {
        pi.sendMessage(
          {
            customType: "cci-notification",
            content: `🔄 Workflow started: **${workflow.name}**`,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: false }
        );
      }
    } else if (type === "workflow-completed") {
      const status = parseStatus(workflow.status);
      const existing = workflows.get(workflow.id);

      if (existing) {
        existing.status = status;
      }

      if (notifications.workflowCompleted && status === "success") {
        pi.sendMessage(
          {
            customType: "cci-notification",
            content: `✅ Workflow **${workflow.name}** passed`,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: false }
        );
      } else if (notifications.workflowFailed && (status === "failed" || status === "canceled")) {
        pi.sendMessage(
          {
            customType: "cci-notification",
            content: `❌ Workflow **${workflow.name}** ${status === "failed" ? "failed" : "was canceled"}`,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: false }
        );
      }

      // Remove from active workflows after a delay
      setTimeout(() => {
        workflows.delete(workflow.id);
      }, 60000);
    }
  }

  // Check if we're still in a git repo
  async function isInGitRepo(cwd: string): Promise<boolean> {
    try {
      await execAsync("git rev-parse --git-dir", { cwd });
      return true;
    } catch {
      return false;
    }
  }

  // Track branch changes
  let lastCheckedBranch: string | null = null;
  let branchCheckInterval: ReturnType<typeof setInterval> | null = null;
  let currentCtx: { cwd: string; ui: ExtensionAPI } | null = null;

  async function checkBranchChange(): Promise<void> {
    if (!currentCtx) return;
    const { cwd } = currentCtx;

    if (!(await isInGitRepo(cwd))) {
      stopSubscription();
      setState("idle");
      return;
    }

    const currentBranchNow = await getGitBranch(cwd);
    if (currentBranchNow && currentBranchNow !== lastCheckedBranch && lastCheckedBranch !== null) {
      await startSubscription(cwd);
    }
    lastCheckedBranch = currentBranchNow;
  }

  // Build status text for display
  function buildStatusText(): string {
    const branch = currentBranch || "unknown";

    // Handle different states
    if (extensionState === "not_installed") {
      return `CCI: ${branch} | ⛔ cci CLI not found`;
    }

    if (extensionState === "not_circleci") {
      return `CCI: ${branch} | ○ Not a CircleCI repo`;
    }

    if (extensionState === "no_remote") {
      return `CCI: ${branch} | ○ No git remote`;
    }

    if (extensionState === "error") {
      return `CCI: ${branch} | ⛔ ${errorMessage}`;
    }

    if (extensionState === "checking" || isRestarting) {
      return `CCI: ${branch} | ◌ Connecting`;
    }

    // Normal subscribed state
    const workflowParts: string[] = [];
    for (const wf of workflows.values()) {
      const icon = STATUS_ICONS[wf.status] || "?";
      if (wf.status === "running") {
        workflowParts.push(`${icon} ${wf.name} (${formatDuration(wf.startedAt)})`);
      } else {
        workflowParts.push(`${icon} ${wf.name}`);
      }
    }

    if (workflowParts.length > 0) {
      return `CCI: ${branch} | ${workflowParts.join(" | ")}`;
    } else if (currentPipelineUrl) {
      return `CCI: ${branch} | idle`;
    } else {
      return `CCI: ${branch}`;
    }
  }

  // Initialize on session start
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;

    // Check if cci CLI is available first
    const available = await isCciAvailable();
    if (!available) {
      setState("not_installed");
    }

    // Start subscription
    await startSubscription(ctx.cwd);

    // Set up status update using setStatus (additive, not replacing footer)
    ctx.ui.setStatus(STATUS_KEY, buildStatusText());

    // Start polling for branch changes and updating status
    branchCheckInterval = setInterval(async () => {
      await checkBranchChange();
      ctx.ui.setStatus(STATUS_KEY, buildStatusText());
    }, 5000);
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    if (branchCheckInterval) {
      clearInterval(branchCheckInterval);
      branchCheckInterval = null;
    }

    stopSubscription();
    currentCtx?.ui.setStatus(STATUS_KEY, undefined);
  });

  // Register command to manually trigger subscription
  pi.registerCommand("cci-subscribe", {
    description: "Restart CircleCI subscription for current branch",
    handler: async (_args, ctx) => {
      await startSubscription(ctx.cwd);
      ctx.ui.setStatus(STATUS_KEY, buildStatusText());
    },
  });

  // Register command to show current status
  pi.registerCommand("cci-status", {
    description: "Show CircleCI workflow status",
    handler: async (_args, ctx) => {
      const statusText = buildStatusText();
      ctx.ui.notify(statusText, "info");
    },
  });
}
