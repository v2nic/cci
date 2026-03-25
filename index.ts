/**
 * CircleCI Webhook Extension for pi
 *
 * Provides real-time CI status in the footer, showing each workflow
 * currently running for the tracked remote branch with links to open
 * in CircleCI.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Types for CircleCI subscription events (raw CircleCI events)
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

// Types for daemon stream events
interface StreamEvent {
  id: string;
  timestamp: string;
  project: string;
  pipelineNumber: number;
  eventType: string;
  icon: string;
  description: string;
  circleCiUrl: string;
  target: string;
  /** True if this is the initial/latest status (not a new update) */
  isLatest?: boolean;
}

// Parsed workflow for display
interface Workflow {
  id: string;
  name: string;
  status: "running" | "success" | "failed" | "canceled" | "queued" | "not_run";
  startedAt: Date;
  pipelineUrl: string;
  pipelineNumber: number;
  branch: string;
}

// Cache for pipeline branch lookups (pipelineNumber -> branch)
const pipelineBranchCache = new Map<number, string>();

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
  let lastPipeline: { status: string; startedAt: Date; pipelineNumber: number; branch: string } | null = null;
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

  // Get the branch name for a specific pipeline number (with caching)
  async function getPipelineBranch(org: string, project: string, pipelineNumber: number): Promise<string | null> {
    // Check cache first
    if (pipelineBranchCache.has(pipelineNumber)) {
      return pipelineBranchCache.get(pipelineNumber)!;
    }

    try {
      const token = process.env.CIRCLECI_TOKEN || process.env.CIRCLE_TOKEN;
      if (!token) {
        console.error("[cci] No CircleCI token found");
        return null;
      }

      const url = `https://circleci.com/api/v2/project/gh/${org}/${project}/pipeline/${pipelineNumber}`;
      const response = await fetch(url, {
        headers: {
          "Circle-Token": token,
          "Accept": "application/json",
        },
      });

      if (!response.ok) {
        console.error(`[cci] Failed to fetch pipeline ${pipelineNumber}: ${response.status}`);
        return null;
      }

      const data = await response.json() as { vcs?: { branch?: string } };
      const branch = data?.vcs?.branch || null;
      
      if (branch) {
        // Cache the result (limit cache size)
        if (pipelineBranchCache.size > 100) {
          const firstKey = pipelineBranchCache.keys().next().value;
          if (firstKey !== undefined) pipelineBranchCache.delete(firstKey);
        }
        pipelineBranchCache.set(pipelineNumber, branch);
      }
      
      return branch;
    } catch (err) {
      console.error(`[cci] Error fetching pipeline ${pipelineNumber}:`, err);
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

  // Format relative time
  function formatRelativeTime(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // Set extension state
  function setState(state: ExtensionState, message: string = ""): void {
    extensionState = state;
    errorMessage = message;
  }

  // Build CCI status line
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
        return `⚙️ CCI: ${branch} | ◌ Checking`;
      case "subscribed":
        if (workflows.size > 0) {
          const parts: string[] = [];
          for (const wf of workflows.values()) {
            const icon = STATUS_ICONS[wf.status] || "?";
            if (wf.status === "running") {
              parts.push(`${icon} ${wf.name} (${formatDuration(wf.startedAt)})`);
            } else {
              parts.push(`${icon} ${wf.name} (${formatRelativeTime(wf.startedAt)})`);
            }
          }
          return `⚙️ CCI: ${branch} | ${parts.join(" | ")}`;
        }
        // Show last pipeline status if available
        if (lastPipeline) {
          const icon = STATUS_ICONS[lastPipeline.status] || "?";
          const timeAgo = formatRelativeTime(lastPipeline.startedAt);
          return `⚙️ CCI: ${branch} | ${icon} last: ${timeAgo}`;
        }
        return `⚙️ CCI: ${branch} | idle`;
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
    currentPipelineUrl = `https://app.circleci.com/pipelines/github/${remote.org}/${remote.project}?branch=${encodeURIComponent(currentBranch || "")}`;

    currentBranch = await getGitBranch(cwd);
    if (!currentBranch || currentBranch === "(detached)") {
      setState("error", "Detached HEAD");
      return;
    }

    // Update pipeline URL with correct branch
    currentPipelineUrl = `https://app.circleci.com/pipelines/github/${remote.org}/${remote.project}?branch=${encodeURIComponent(currentBranch)}`;

    console.log(`[cci] Subscribing to pipelines for branch ${currentBranch}`);

    setState("checking");

    const subscribeTarget = `pipelines/github/${currentOrg}/${currentProject}`;
    try {
      // Use --include-latest to get current status on subscribe
      cciProcess = spawn(cciPath, ["subscribe", subscribeTarget, "--include-latest"], {
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
          const parsed = JSON.parse(line);
          // Check if it's a daemon stream event (has eventType) or raw CircleCI event (has type)
          if ("eventType" in parsed) {
            handleStreamEvent(parsed as StreamEvent);
          } else if ("type" in parsed) {
            handleWorkflowEvent(parsed as CciWorkflowEvent);
          }
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

  // Check if pipeline branch matches current branch (async with caching)
  async function checkPipelineBranch(pipelineNumber: number): Promise<boolean> {
    // Get branch from cache or API
    let branch = pipelineBranchCache.get(pipelineNumber);
    
    if (!branch && currentOrg && currentProject) {
      branch = await getPipelineBranch(currentOrg, currentProject, pipelineNumber);
    }
    
    if (!branch) return true; // If we can't determine branch, show notification to be safe
    
    // Check if the branch matches our current branch (normalize for comparison)
    const normalizedEventBranch = branch.replace(/^refs\/heads\//, '').toLowerCase();
    const normalizedCurrentBranch = (currentBranch || '').replace(/^refs\/heads\//, '').toLowerCase();
    
    return normalizedEventBranch === normalizedCurrentBranch;
  }

  // Handle workflow events
  function handleWorkflowEvent(event: CciWorkflowEvent): void {
    const { type, workflow, pipeline, isLatest } = event;

    if (type === "workflow-started") {
      const wf: Workflow = {
        id: workflow.id,
        name: workflow.name,
        status: parseStatus(workflow.status),
        startedAt: new Date(workflow.started_at || Date.now()),
        pipelineUrl: `https://app.circleci.com/pipelines/${pipeline.project_slug}/${pipeline.number}`,
        pipelineNumber: pipeline.number,
        branch: pipelineBranchCache.get(pipeline.number) || "",
      };
      workflows.set(workflow.id, wf);

      // Only steer on real updates, not initial/latest status
      // Branch check is done async, but we add to workflows for display regardless
      if (!isLatest && notifications.workflowStarted) {
        // Check branch asynchronously
        checkPipelineBranch(pipeline.number).then(matches => {
          if (matches) {
            pi.sendMessage(
              { customType: "cci-notification", content: `🔄 Workflow **${workflow.name}** started`, display: true },
              { deliverAs: "steer", triggerTurn: false }
            );
          }
        });
      }
    } else if (type === "workflow-completed") {
      const status = parseStatus(workflow.status);
      const existing = workflows.get(workflow.id);
      if (existing) {
        existing.status = status;
      }

      // Only steer on real updates, not initial/latest status
      if (!isLatest) {
        if (notifications.workflowCompleted && status === "success") {
          checkPipelineBranch(pipeline.number).then(matches => {
            if (matches) {
              pi.sendMessage(
                { customType: "cci-notification", content: `✅ Workflow **${workflow.name}** passed`, display: true },
                { deliverAs: "steer", triggerTurn: false }
              );
            }
          });
        } else if (notifications.workflowFailed && (status === "failed" || status === "canceled")) {
          checkPipelineBranch(pipeline.number).then(matches => {
            if (matches) {
              pi.sendMessage(
                { customType: "cci-notification", content: `❌ Workflow **${workflow.name}** ${status === "failed" ? "failed" : "canceled"}`, display: true },
                { deliverAs: "steer", triggerTurn: false }
              );
            }
          });
        }
      }

      // Remove completed workflows after delay (only for real updates)
      if (!isLatest) {
        setTimeout(() => {
          workflows.delete(workflow.id);
        }, 60000);
      }
    }
  }

  // Handle daemon stream events (pipeline-level status updates)
  function handleStreamEvent(event: StreamEvent): void {
    const { eventType, timestamp, circleCiUrl, isLatest, pipelineNumber } = event;

    if (!pipelineNumber) return; // Skip events without pipeline number

    // Build URL with pipeline number if not present in circleCiUrl
    const pipelineUrl = `https://app.circleci.com/pipelines/github/${currentOrg}/${currentProject}/${pipelineNumber}`;

    // Update last pipeline status (branch will be added async)
    lastPipeline = {
      status: eventType,
      startedAt: new Date(timestamp),
      pipelineNumber,
      branch: pipelineBranchCache.get(pipelineNumber) || "",
    };

    // Only steer on real updates, not initial/latest status
    if (!isLatest) {
      // Check branch asynchronously
      checkPipelineBranch(pipelineNumber).then(matches => {
        if (!matches) return; // Skip if branch doesn't match

        if (eventType === "success" && notifications.workflowCompleted) {
          pi.sendMessage(
            { customType: "cci-notification", content: `✅ Pipeline **passed** ${pipelineUrl}`, display: true },
            { deliverAs: "steer", triggerTurn: false }
          );
        } else if ((eventType === "failed" || eventType === "error" || eventType === "canceled") && notifications.workflowFailed) {
          pi.sendMessage(
            { customType: "cci-notification", content: `❌ Pipeline **${eventType}** ${pipelineUrl}`, display: true },
            { deliverAs: "steer", triggerTurn: false }
          );
        }
      });
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

    // Set up custom footer that replicates default footer + adds CCI on new line at end
    ctx.ui.setFooter((tui, theme, footerData) => {
      tuiRef = tui;

      return {
        dispose() {
          tuiRef = null;
        },
        invalidate() {},
        render(width: number): string[] {
          // Line 1: PWD + branch + session name
          let pwd = process.cwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }

          const branch = footerData.getGitBranch();
          if (branch) {
            pwd = `${pwd} • ${branch}`;
          }

          // Line 2: Token stats + model info
          let input = 0, output = 0, cost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              input += m.usage.input;
              output += m.usage.output;
              cost += m.usage.cost.total;
            }
          }

          const fmt = (n: number) => n < 1000 ? `${n}` : n < 10000 ? `${(n/1000).toFixed(1)}k` : `${Math.round(n/1000)}k`;
          const costFmt = (n: number) => n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;

          const modelId = ctx.model?.id || "no-model";
          let statsParts = [];
          if (input) statsParts.push(`↑${fmt(input)}`);
          if (output) statsParts.push(`↓${fmt(output)}`);
          if (cost > 0) statsParts.push(costFmt(cost));
          const statsLine = `${statsParts.join(" ")} ${modelId}`;

          // Line 3: Other extension statuses (excluding our CCI status)
          const extensionStatuses = footerData.getExtensionStatuses();
          const otherStatuses = Array.from(extensionStatuses.entries())
            .filter(([key]) => key !== "cci")
            .map(([, text]) => text.replace(/[\r\n]/g, " ").trim())
            .filter(Boolean);

          // Build result - CCI goes LAST, on its own line
          const lines: string[] = [
            theme.fg("dim", pwd),
            theme.fg("dim", statsLine),
          ];

          if (otherStatuses.length > 0) {
            lines.push(theme.fg("dim", otherStatuses.join(" ")));
          }

          // CCI status on its own line at the end
          lines.push(theme.fg("dim", buildCciStatus()));

          return lines;
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
      ctx.ui.notify(buildCciStatus(), "info");
    },
  });
}
