import { RECENT_PIPELINES_LIMIT, getCircleCiBaseUrl } from './config';
import { formatTarget, toCircleCiPipelineUrl } from './targets';
import type {
  AggregateStatus,
  Collaboration,
  PipelineSnapshot,
  ProjectRecord,
  StreamEvent,
  SubscriptionTarget,
  WorkflowSummary,
} from './types';

export class CircleCiClient {
  constructor(
    private readonly tokenProvider: () => string | null,
    private readonly baseUrl = getCircleCiBaseUrl(),
  ) {}

  private getToken(): string {
    const token = this.tokenProvider()?.trim();
    if (!token) {
      throw new Error('CircleCI token is not configured');
    }
    return token;
  }

  private async request<T>(pathname: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      headers: {
        'Circle-Token': this.getToken(),
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`CircleCI request failed (${response.status}): ${message}`);
    }

    return (await response.json()) as T;
  }

  async validateToken(candidate: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/me/collaborations`, {
      headers: {
        'Circle-Token': candidate.trim(),
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Token validation failed with status ${response.status}`);
    }
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const payload = await this.request<{ items?: Collaboration[] }>('/me/collaborations');
    const deduped = new Map<string, ProjectRecord>();

    for (const item of payload.items ?? []) {
      const slug = item.project_slug?.trim();
      if (!slug) {
        continue;
      }

      const parts = slug.split('/');
      if (parts.length !== 3 || parts[0] !== 'gh') {
        continue;
      }

      const project: ProjectRecord = {
        provider: 'github',
        org: parts[1],
        project: parts[2],
        slug,
        displayName: `${parts[1]}/${parts[2]}`,
      };

      deduped.set(slug, project);
    }

    return [...deduped.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }

  async getPipelineId(org: string, project: string, pipelineNumber: number): Promise<string> {
    const payload = await this.request<{ id?: string }>(
      `/project/gh/${org}/${project}/pipeline/${pipelineNumber}`,
    );
    if (!payload.id) {
      throw new Error('Pipeline ID was not returned by CircleCI');
    }
    return payload.id;
  }

  async getPipelineWorkflows(pipelineId: string): Promise<WorkflowSummary[]> {
    const payload = await this.request<{
      items?: Array<{ id?: string; name?: string; status?: string }>;
    }>(`/pipeline/${pipelineId}/workflow`);
    return (payload.items ?? [])
      .filter((item) => item.id && item.status)
      .map((item) => ({
        id: item.id as string,
        name: item.name ?? item.id ?? 'workflow',
        status: item.status as string,
      }));
  }

  async getPipelineSnapshot(target: {
    org: string;
    project: string;
    pipelineNumber: number;
  }): Promise<PipelineSnapshot> {
    const pipelineId = await this.getPipelineId(target.org, target.project, target.pipelineNumber);
    const workflows = await this.getPipelineWorkflows(pipelineId);
    return {
      id: pipelineId,
      number: target.pipelineNumber,
      projectSlug: `gh/${target.org}/${target.project}`,
      webUrl: toCircleCiPipelineUrl({ kind: 'pipeline', provider: 'github', ...target }),
      state: aggregateStatus(workflows),
      workflows,
    };
  }

  async listRecentPipelines(org: string, project: string): Promise<PipelineSnapshot[]> {
    const payload = await this.request<{
      items?: Array<{ id?: string; number?: number; created_at?: string }>;
    }>(`/project/gh/${org}/${project}/pipeline?limit=${RECENT_PIPELINES_LIMIT}`);

    const results: PipelineSnapshot[] = [];

    for (const item of payload.items ?? []) {
      if (!item.id || typeof item.number !== 'number') {
        continue;
      }

      const workflows = await this.getPipelineWorkflows(item.id);
      results.push({
        id: item.id,
        number: item.number,
        projectSlug: `gh/${org}/${project}`,
        webUrl: toCircleCiPipelineUrl({
          kind: 'pipeline',
          provider: 'github',
          org,
          project,
          pipelineNumber: item.number,
        }),
        createdAt: item.created_at,
        state: aggregateStatus(workflows),
        workflows,
      });
    }

    return results.sort((left, right) => right.number - left.number);
  }

  async awaitPipeline(
    target: { org: string; project: string; pipelineNumber: number },
    timeoutMs: number,
    pollIntervalMs: number,
  ): Promise<PipelineSnapshot> {
    const start = Date.now();
    while (true) {
      const snapshot = await this.getPipelineSnapshot(target);
      if (isTerminalStatus(snapshot.state)) {
        return snapshot;
      }
      if (timeoutMs > 0 && Date.now() - start >= timeoutMs) {
        throw new AwaitTimeoutError(
          formatTarget({ kind: 'pipeline', provider: 'github', ...target }),
        );
      }
      await Bun.sleep(pollIntervalMs);
    }
  }
}

export class AwaitTimeoutError extends Error {}

export function aggregateStatus(workflows: WorkflowSummary[]): AggregateStatus {
  if (workflows.length === 0) {
    return 'unknown';
  }

  let hasRunning = false;
  let hasFailure = false;
  let hasOnHold = false;

  for (const workflow of workflows) {
    switch (workflow.status) {
      case 'success':
        break;
      case 'running':
        hasRunning = true;
        break;
      case 'on_hold':
        hasOnHold = true;
        break;
      case 'failed':
      case 'error':
      case 'canceled':
      case 'unauthorized':
      case 'not_run':
        hasFailure = true;
        break;
      default:
        hasRunning = true;
        break;
    }
  }

  if (hasOnHold) {
    return 'on_hold';
  }
  if (hasRunning) {
    return 'running';
  }
  if (hasFailure) {
    return 'failed';
  }
  return 'success';
}

export function isTerminalStatus(status: AggregateStatus): boolean {
  return status !== 'running' && status !== 'unknown';
}

export function toStreamEvent(target: SubscriptionTarget, snapshot: PipelineSnapshot): StreamEvent {
  const project = snapshot.projectSlug.replace(/^gh\//, '');
  return {
    id: `${snapshot.projectSlug}:${snapshot.number}:${snapshot.state}`,
    timestamp: new Date().toISOString(),
    project,
    pipelineNumber: snapshot.number,
    eventType: snapshot.state,
    icon: iconForStatus(snapshot.state),
    description: describeSnapshot(snapshot),
    circleCiUrl: snapshot.webUrl,
    target: formatTarget(target),
  };
}

export function iconForStatus(status: AggregateStatus): string {
  switch (status) {
    case 'success':
      return '✅';
    case 'failed':
    case 'error':
      return '❌';
    case 'on_hold':
      return '⏸️';
    case 'running':
      return '⏳';
    case 'canceled':
      return '🚫';
    default:
      return 'ℹ️';
  }
}

export function describeSnapshot(snapshot: PipelineSnapshot): string {
  const workflowSummary = snapshot.workflows
    .map((workflow) => `${workflow.name}:${workflow.status}`)
    .join(', ');
  return `Pipeline #${snapshot.number} is ${snapshot.state}${workflowSummary ? ` (${workflowSummary})` : ''}`;
}
