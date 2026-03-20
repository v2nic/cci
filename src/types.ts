export type VcsProvider = 'github';

export type PipelineTarget = {
  kind: 'pipeline';
  provider: VcsProvider;
  org: string;
  project: string;
  pipelineNumber: number;
};

export type ProjectTarget = {
  kind: 'project';
  provider: VcsProvider;
  org: string;
  project: string;
};

export type SubscriptionTarget = PipelineTarget | ProjectTarget;

export type SystemStreamEvent = {
  id: string;
  timestamp: string;
  kind: 'subscribed';
  message: string;
  targets: string[];
};

export type StreamMessage =
  | { type: 'event'; payload: StreamEvent }
  | { type: 'system'; payload: SystemStreamEvent };

export type AggregateStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'on_hold'
  | 'not_run'
  | 'unauthorized'
  | 'canceled'
  | 'error'
  | 'unknown';

export type WorkflowSummary = {
  id: string;
  name: string;
  status: string;
};

export type PipelineSnapshot = {
  id: string;
  number: number;
  projectSlug: string;
  webUrl: string;
  createdAt?: string;
  state: AggregateStatus;
  workflows: WorkflowSummary[];
};

export type Collaboration = {
  organization_name?: string;
  organization_slug?: string;
  vcs_type?: string;
  project_slug?: string;
  project_name?: string;
};

export type ProjectRecord = {
  provider: VcsProvider;
  org: string;
  project: string;
  slug: string;
  displayName: string;
};

export type StreamEvent = {
  id: string;
  timestamp: string;
  project: string;
  pipelineNumber: number;
  eventType: AggregateStatus;
  icon: string;
  description: string;
  circleCiUrl: string;
  target: string;
};
