import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'cci-home-'));
process.env.CCI_HOME = tempHome;
process.env.CCI_CIRCLECI_BASE_URL = 'http://127.0.0.1:40111';
process.env.CCI_POLL_INTERVAL_MS = '50';
process.env.CCI_IDLE_STOP_MS = '50';

const { startDaemon } = await import(`../src/daemon.ts?integration=${Date.now()}`);

let currentWorkflowStatus = 'running';
let pipelineRequestCount = 0;
let workflowRequestCount = 0;
const mockApi = Bun.serve({
  hostname: '127.0.0.1',
  port: 40111,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/me/collaborations') {
      if (req.headers.get('Circle-Token') !== 'real-token') {
        return new Response('unauthorized', { status: 401 });
      }
      return Response.json({
        items: [{ project_slug: 'gh/acme/example' }],
      });
    }

    if (url.pathname === '/project/gh/acme/example/pipeline/42') {
      pipelineRequestCount += 1;
      return Response.json({ id: 'pipeline-id-42' });
    }

    if (url.pathname === '/pipeline/pipeline-id-42/workflow') {
      workflowRequestCount += 1;
      return Response.json({
        items: [{ id: 'workflow-1', name: 'build', status: currentWorkflowStatus }],
      });
    }

    if (url.pathname === '/project/gh/acme/example/pipeline') {
      return Response.json({
        items: [{ id: 'pipeline-id-42', number: 42, created_at: '2026-03-20T00:00:00.000Z' }],
      });
    }

    return new Response('not found', { status: 404 });
  },
});

let daemon: Bun.Server<undefined>;
const daemonPort = 22431;

beforeAll(async () => {
  daemon = await startDaemon(daemonPort);
});

afterAll(() => {
  daemon.stop(true);
  mockApi.stop(true);
});

describe('daemon integration', () => {
  it('validates login and writes the token file with strict permissions', async () => {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'real-token' }),
    });

    expect(response.status).toBe(200);

    const tokenPath = join(tempHome, '.circleci', 'token');
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe('real-token');
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('lists projects after login', async () => {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/api/projects?q=example`);
    const payload = (await response.json()) as {
      items: Array<{
        displayName: string;
        org: string;
        project: string;
        provider: string;
        slug: string;
        target: string;
      }>;
    };

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toEqual({
      displayName: 'acme/example',
      org: 'acme',
      project: 'example',
      provider: 'github',
      slug: 'gh/acme/example',
      target: 'pipelines/github/acme/example',
    });
  });

  it('awaits pipeline completion through the daemon API', async () => {
    setTimeout(() => {
      currentWorkflowStatus = 'success';
    }, 80);

    const response = await fetch(`http://127.0.0.1:${daemonPort}/api/await-completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'pipelines/github/acme/example/42',
        timeoutMs: 1000,
      }),
    });

    const payload = (await response.json()) as {
      snapshot: { number: number; state: string };
    };

    expect(response.status).toBe(200);
    expect(payload.snapshot.number).toBe(42);
    expect(payload.snapshot.state).toBe('success');
  });

  it('shares polling across subscribers and stops after the idle window', async () => {
    pipelineRequestCount = 0;
    workflowRequestCount = 0;
    currentWorkflowStatus = 'success';

    const target = 'pipelines/github/acme/example/42';
    const messagesBySocket: Array<
      Array<{ type?: string; payload?: { kind?: string; message?: string } }>
    > = [[], []];

    const openSocket = async (index: number) => {
      const socket = new WebSocket(`ws://127.0.0.1:${daemonPort}/ws`);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
          once: true,
        });
      });

      socket.addEventListener('message', (event) => {
        const text = typeof event.data === 'string' ? event.data : '';
        messagesBySocket[index].push(JSON.parse(text));
      });

      socket.send(JSON.stringify({ type: 'subscribe', targets: [target] }));
      return socket;
    };

    const firstSocket = await openSocket(0);
    const secondSocket = await openSocket(1);

    await waitFor(() => messagesBySocket[0].some((message) => message.type === 'system'));
    await waitFor(() => messagesBySocket[1].some((message) => message.type === 'system'));
    await waitFor(() =>
      messagesBySocket.every((messages) => messages.some((message) => message.type === 'event')),
    );

    expect(pipelineRequestCount).toBe(1);
    expect(workflowRequestCount).toBe(1);
    expect(messagesBySocket[0][0]?.type).toBe('system');
    expect(messagesBySocket[0][0]?.payload?.kind).toBe('subscribed');
    expect(messagesBySocket[1][0]?.type).toBe('system');
    expect(messagesBySocket[1][0]?.payload?.kind).toBe('subscribed');

    firstSocket.close();
    secondSocket.close();

    const pipelineCountAfterClose = pipelineRequestCount;
    const workflowCountAfterClose = workflowRequestCount;

    await Bun.sleep(180);

    expect(pipelineRequestCount).toBeGreaterThanOrEqual(pipelineCountAfterClose);
    expect(workflowRequestCount).toBeGreaterThanOrEqual(workflowCountAfterClose);

    const pipelineCountAfterIdleStop = pipelineRequestCount;
    const workflowCountAfterIdleStop = workflowRequestCount;

    await Bun.sleep(120);

    expect(pipelineRequestCount).toBe(pipelineCountAfterIdleStop);
    expect(workflowRequestCount).toBe(workflowCountAfterIdleStop);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await Bun.sleep(10);
  }

  throw new Error('Timed out waiting for condition');
}
