import type { PipelineTarget, ProjectTarget, SubscriptionTarget } from './types';

const pipelinePattern = /^pipelines\/github\/([^/]+)\/([^/]+)\/(\d+)$/;
const projectPattern = /^pipelines\/github\/([^/]+)\/([^/]+)$/;
const workflowPattern = /^pipelines\/github\/([^/]+)\/([^/]+)\/(\d+)\/workflows\/([^/?#]+)$/;

function normalizeTargetValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return trimmed.replace(/[?#].*$/, '');
  }

  const url = new URL(trimmed);
  return url.pathname.replace(/^\/+|\/+$/g, '');
}

export function parseTarget(value: string): SubscriptionTarget {
  const normalizedValue = normalizeTargetValue(value);

  const workflowMatch = normalizedValue.match(workflowPattern);
  if (workflowMatch) {
    return {
      kind: 'pipeline',
      provider: 'github',
      org: workflowMatch[1],
      project: workflowMatch[2],
      pipelineNumber: Number.parseInt(workflowMatch[3], 10),
    } satisfies PipelineTarget;
  }

  const pipelineMatch = normalizedValue.match(pipelinePattern);
  if (pipelineMatch) {
    return {
      kind: 'pipeline',
      provider: 'github',
      org: pipelineMatch[1],
      project: pipelineMatch[2],
      pipelineNumber: Number.parseInt(pipelineMatch[3], 10),
    } satisfies PipelineTarget;
  }

  const projectMatch = normalizedValue.match(projectPattern);
  if (projectMatch) {
    return {
      kind: 'project',
      provider: 'github',
      org: projectMatch[1],
      project: projectMatch[2],
    } satisfies ProjectTarget;
  }

  throw new Error(`Unsupported target: ${value}`);
}

export function formatTarget(target: SubscriptionTarget): string {
  if (target.kind === 'pipeline') {
    return `pipelines/${target.provider}/${target.org}/${target.project}/${target.pipelineNumber}`;
  }

  return `pipelines/${target.provider}/${target.org}/${target.project}`;
}

export function toProjectSlug(target: SubscriptionTarget): string {
  return `gh/${target.org}/${target.project}`;
}

export function toCircleCiPipelineUrl(target: PipelineTarget): string {
  return `https://app.circleci.com/pipelines/${target.provider}/${target.org}/${target.project}/${target.pipelineNumber}`;
}
