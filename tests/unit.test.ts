import { describe, expect, it } from 'bun:test';
import { aggregateStatus, describeSnapshot } from '../src/circleci';
import { formatTarget, parseTarget } from '../src/targets';
import { renderWebApp } from '../src/web';

describe('target parsing', () => {
  it('parses a pipeline target', () => {
    const target = parseTarget('pipelines/github/acme/example/42');
    expect(target).toEqual({
      kind: 'pipeline',
      provider: 'github',
      org: 'acme',
      project: 'example',
      pipelineNumber: 42,
    });
  });

  it('parses a pipeline URL and strips the host and query string', () => {
    const target = parseTarget(
      'https://app.circleci.com/pipelines/github/acme/example/42?branch=main',
    );
    expect(target).toEqual({
      kind: 'pipeline',
      provider: 'github',
      org: 'acme',
      project: 'example',
      pipelineNumber: 42,
    });
  });

  it('parses a project target', () => {
    const target = parseTarget('pipelines/github/acme/example');
    expect(target).toEqual({
      kind: 'project',
      provider: 'github',
      org: 'acme',
      project: 'example',
    });
    expect(formatTarget(target)).toBe('pipelines/github/acme/example');
  });

  it('parses a workflow URL and strips the host and query string', () => {
    const target = parseTarget(
      'https://app.circleci.com/pipelines/github/acme/example/42/workflows/abc123?foo=bar',
    );
    expect(target).toEqual({
      kind: 'pipeline',
      provider: 'github',
      org: 'acme',
      project: 'example',
      pipelineNumber: 42,
    });
  });
});

describe('workflow aggregation', () => {
  it('returns success when all workflows succeeded', () => {
    expect(
      aggregateStatus([
        { id: 'wf-1', name: 'build', status: 'success' },
        { id: 'wf-2', name: 'test', status: 'success' },
      ]),
    ).toBe('success');
  });

  it('returns running when at least one workflow is running', () => {
    expect(
      aggregateStatus([
        { id: 'wf-1', name: 'build', status: 'success' },
        { id: 'wf-2', name: 'test', status: 'running' },
      ]),
    ).toBe('running');
  });

  it('returns on_hold before failure', () => {
    expect(
      aggregateStatus([
        { id: 'wf-1', name: 'approval', status: 'on_hold' },
        { id: 'wf-2', name: 'test', status: 'failed' },
      ]),
    ).toBe('on_hold');
  });

  it('describes a snapshot', () => {
    expect(
      describeSnapshot({
        id: 'pipeline-1',
        number: 7,
        projectSlug: 'gh/acme/example',
        webUrl: 'https://app.circleci.com/pipelines/github/acme/example/7',
        state: 'success',
        workflows: [{ id: 'wf-1', name: 'build', status: 'success' }],
      }),
    ).toContain('Pipeline #7 is success');
  });
});

describe('web renderer', () => {
  it('boots a React app through Babel', () => {
    const html = renderWebApp(2243);
    expect(html).toContain('react.development.js');
    expect(html).toContain('react-dom.development.js');
    expect(html).toContain('@babel/standalone');
    expect(html).toContain('type="text/babel"');
    expect(html).toContain('createRoot(document.getElementById("root"))');
  });
});
