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

  // Load configuration
  function loadConfig(): CciConfig {
    return DEFAULT_CONFIG;
  }

  // Check if .circleci/config.yml exists
  async function isCircleCIEnabled(cwd: string): Promise<boolean> {
    try {
      await access(cwd + "/.circleci/config.yml");
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

      const gitMatch = url.match(/git@github\.com:(.+?)\/(.+?)(?:\.git)?$/);
      const httpsMatch = url.match(/https?:\/\/github\.com\/(.+?)\/(.+?)(?:\.git)?$/);

      if (gitMatch) return { org: gitMatch[1], project: gitMatch[2] };
      if (httpsMatch) return { org: httpsMatch[1], project: httpsMatch[2] };
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

  // Parse workflow status
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

  // Set extension state
  function setState(state: ExtensionState, message: string = ""): void {
    extensionState = state;
    errorMessage = message;
  }

  // Build CCI status line for footer
  function buildCciStatus(): string {
    const branch = currentBranch || "unknown";

    switch (extensionState) {
      case "not_installed":
        return `⚙️ CCI: ${branch} | ⛔ cci CLI not found`;
      case "not_circleci":
        return `⚙️ CCI: ${branch} | ○ Not a CircleCI repo`;
      case "no_remote":
        return `⚙️ CCI: ${branch} | ○ No git remote`;
      case "error":
        return `⚙️ CCI: ${branch} | ⛔ ${errorMessage}`;
      case "checking":
      case "idle":
        return `⚙️ CCI: ${branch} | ◌ Checking...`;
      case "subscribed":
        if (workflows.size === 0) {
          return `⚙️ CCI: ${branch} | idle`;
        }
        const parts: string[] = [];
        for (const wf of workflows.values()) {
          const icon = STATUS_ICONS[wf.status] || "?";
          if (wf.status === "running") {
            parts.push(`${icon} ${wf.name} (${formatDuration(wf.startedAt)})`);
          } else {
            parts.push(`${icon} ${wf.name}`);
          }
        }
        return `⚙️ CCI: ${branch} | ${parts.join(" | ")}`;
      default:
        return `⚙️ CCI: ${branch}`;
    }
  }

  // Start cci subscribe process
  async function startSubscription(cwd: string): Promise<void> {
    stopSubscription();
    setState("checking");

    if (!(await isCircleCIEnabled(cwd))) {
      setState("not_circleci");
      return;
    }

    const remote = await getGitRemote(cwd);
    if (!remote) {
      setState("no_remote");
      return;
    }

    if (!(await isCciAvailable())) {
      setState("not_installed");
      return;
    }

    currentOrg = remote.org;
    currentProject = remote.project;
    currentPipelineUrl = `https://app.circleci.com/pipelines/${remote.org}/${remote.project}`;

    currentBranch = await getGitBranch(cwd);
    if (!currentBranch || currentBranch === "(detached)") {
      setState("error", "Detached HEAD");
      return;
    }

    setState("checking");

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
        } catch {
          // Ignore parse errors
        }
      }
    });

    // Silently ignore stderr
    cciProcess.stderr.on("data", () => {});

    cciProcess.on("error", (err: Error) => {
      if (err.message.includes("ENOENT")) {
        setState("not_installed");
        return;
      }
      if (restartAttempts === 0) {
        setState("error", "Connection failed");
      }
      scheduleRestart(cwd);
    });

    cciProcess.on("exit", (code: number | null) => {
      if (["not_installed", "not_circleci", "no_remote"].includes(extensionState)) {
        return;
      }
      if (code !== 0 && code !== null && !isRestarting) {
        scheduleRestart(cwd);
      }
    });

    restartAttempts = 0;
    setState("subscribed");
  }

  // Stop subscription
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

  // Schedule restart with backoff
  function scheduleRestart(cwd: string): void {
    if (["not_installed", "not_circleci", "no_remote"].includes(extensionState)) {
      return;
    }

    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      setState("error", `Max retries (${MAX_RESTART_ATTEMPTS}) exceeded`);
      isRestarting = false;
      return;
    }

    isRestarting = true;
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
          { customType: "cci-notification", content: `🔄 Workflow **${workflow.name}** started`, display: true },
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
          { customType: "cci-notification", content: `✅ Workflow **${workflow.name}** passed`, display: true },
          { deliverAs: "steer", triggerTurn: false }
        );
      } else if (notifications.workflowFailed && (status === "failed" || status === "canceled")) {
        pi.sendMessage(
          { customType: "cci-notification", content: `❌ Workflow **${workflow.name}** ${status === "failed" ? "failed" : "canceled"}`, display: true },
          { deliverAs: "steer", triggerTurn: false }
        );
      }

      // Remove after delay
      setTimeout(() => {
        workflows.delete(workflow.id);
      }, 60000);
    }
  }

  // Check if still in git repo
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
  let currentCtx: { cwd: string; ui: ExtensionAPI["ui"] } | null = null;
  let tuiRef: { requestRender: () => void } | null = null;

  async function checkBranchChange(): Promise<void> {
    if (!currentCtx) return;

    if (!(await isInGitRepo(currentCtx.cwd))) {
      stopSubscription();
      setState("idle");
      return;
    }

    const currentBranchNow = await getGitBranch(currentCtx.cwd);
    if (currentBranchNow && currentBranchNow !== lastCheckedBranch && lastCheckedBranch !== null) {
      await startSubscription(currentCtx.cwd);
    }
    lastCheckedBranch = currentBranchNow;
  }

  // Initialize
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;

    const available = await isCciAvailable();
    if (!available) {
      setState("not_installed");
    }

    await startSubscription(ctx.cwd);

    // Set up custom footer
    ctx.ui.setFooter((tui, theme) => {
      tuiRef = tui;

      return {
        dispose() {
          tuiRef = null;
        },
        invalidate() {},
        render(width: number): string[] {
          // CCI status line - fill the full width
          const cciLine = theme.fg("dim", buildCciStatus());
          const padding = " ".repeat(Math.max(0, width - [...cciLine].filter(c => !c.startsWith('\x1b')).length));
          const fullLine = cciLine + theme.fg("dim", padding);
          return [fullLine];
        },
      };
    });

    // Start polling for branch changes
    branchCheckInterval = setInterval(async () => {
      await checkBranchChange();
      tuiRef?.requestRender();
    }, 5000);
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    if (branchCheckInterval) {
      clearInterval(branchCheckInterval);
      branchCheckInterval = null;
    }
    stopSubscription();
    currentCtx = null;
  });

  // Register command to restart subscription
  pi.registerCommand("cci-subscribe", {
    description: "Restart CircleCI subscription for current branch",
    handler: async (_args, ctx) => {
      await startSubscription(ctx.cwd);
      tuiRef?.requestRender();
    },
  });

  // Register command to show status
  pi.registerCommand("cci-status", {
    description: "Show CircleCI workflow status",
    handler: async (_args, ctx) => {
      const status = buildCciStatus();
      ctx.ui.notify(status, "info");
    },
  });
}
