import { AwaitTimeoutError, CircleCiClient, toStreamEvent } from './circleci';
import { DEFAULT_HOST, DEFAULT_PORT, getIdleStopMs, getPollIntervalMs } from './config';
import { formatTarget, parseTarget } from './targets';
import { readStoredToken, writeStoredToken } from './token-store';
import type { PipelineSnapshot, StreamEvent, SubscriptionTarget, SystemStreamEvent } from './types';
import { renderWebApp } from './web';

export type DaemonState = {
  token: string | null;
  subscriptionsBySocket: Map<string, Set<string>>;
  socketTargets: Map<string, SubscriptionTarget[]>;
  lastStateByPipeline: Map<string, string>;
  /** True if the next poll should mark events as latest (initial state) */
  includeLatest: boolean;
  /** True if we've already sent the initial latest events */
  initialLatestSent: boolean;
  server?: Bun.Server<SocketData>;
};

type SocketData = {
  id: string;
  includeLatest: boolean;
};

export async function startDaemon(port = DEFAULT_PORT): Promise<Bun.Server<SocketData>> {
  const state: DaemonState = {
    token: readStoredToken(),
    subscriptionsBySocket: new Map(),
    socketTargets: new Map(),
    lastStateByPipeline: new Map(),
    includeLatest: false,
    initialLatestSent: false,
  };

  const client = new CircleCiClient(() => state.token);
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let idleStopTimer: ReturnType<typeof setTimeout> | undefined;

  const getActiveTargets = () => {
    const uniqueTargets = new Map<string, SubscriptionTarget>();
    for (const targets of state.socketTargets.values()) {
      for (const target of targets) {
        uniqueTargets.set(formatTarget(target), target);
      }
    }
    return [...uniqueTargets.values()];
  };

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }

    if (idleStopTimer) {
      clearTimeout(idleStopTimer);
      idleStopTimer = undefined;
    }
  };

  const ensurePolling = () => {
    const activeTargets = getActiveTargets();

    if (activeTargets.length === 0) {
      if (!idleStopTimer) {
        idleStopTimer = setTimeout(() => {
          idleStopTimer = undefined;
          if (getActiveTargets().length === 0) {
            stopPolling();
          }
        }, getIdleStopMs());
      }
      return;
    }

    if (idleStopTimer) {
      clearTimeout(idleStopTimer);
      idleStopTimer = undefined;
    }

    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void poll();
      }, getPollIntervalMs());
    }
  };

  const sendSubscribedEvent = (ws: { send(data: string): void }, targets: string[]) => {
    const payload: SystemStreamEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'subscribed',
      message: `Subscribed to ${targets.length} target${targets.length === 1 ? '' : 's'}`,
      targets,
    };
    ws.send(JSON.stringify({ type: 'system', payload }));
  };

  const poll = async () => {
    const targets = getActiveTargets();
    if (targets.length === 0 || !state.server) {
      return;
    }

    for (const target of targets) {
      try {
        if (target.kind === 'pipeline') {
          const snapshot = await client.getPipelineSnapshot(target);
          publishIfChanged(state, target, snapshot);
        } else {
          const snapshots = await client.listRecentPipelines(target.org, target.project);
          for (const snapshot of snapshots) {
            publishIfChanged(state, target, snapshot);
          }
        }
      } catch (error) {
        const event: StreamEvent = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          project: `${target.org}/${target.project}`,
          pipelineNumber: 0,
          eventType: 'error',
          icon: '⚠️',
          description: error instanceof Error ? error.message : 'Unknown error',
          circleCiUrl: `https://app.circleci.com/pipelines/${target.provider}/${target.org}/${target.project}`,
          target:
            target.kind === 'pipeline'
              ? `pipelines/${target.provider}/${target.org}/${target.project}/${target.pipelineNumber}`
              : `pipelines/${target.provider}/${target.org}/${target.project}`,
        };
        state.server.publish('events', JSON.stringify({ type: 'event', payload: event }));
      }
    }
  };

  const server = Bun.serve<SocketData>({
    hostname: DEFAULT_HOST,
    port,
    idleTimeout: 30,
    fetch(req, serverRef) {
      const url = new URL(req.url);

      if (url.pathname === '/health') {
        return Response.json({ ok: true });
      }

      if (url.pathname === '/') {
        return new Response(renderWebApp(port), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (url.pathname === '/api/projects' && req.method === 'GET') {
        return handleProjects(client, url);
      }

      if (url.pathname === '/api/login' && req.method === 'POST') {
        return handleLogin(req, client, state);
      }

      if (url.pathname === '/api/await-completion' && req.method === 'POST') {
        return handleAwaitCompletion(req, client);
      }

      if (url.pathname === '/ws') {
        const socketId = crypto.randomUUID();
        const upgraded = serverRef.upgrade(req, { data: { id: socketId } });
        if (upgraded) {
          return undefined;
        }
        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      return new Response('Not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        state.subscriptionsBySocket.set(ws.data.id, new Set());
        state.socketTargets.set(ws.data.id, []);
        ws.data.includeLatest = false;
        ws.subscribe('events');
      },
      close(ws) {
        state.subscriptionsBySocket.delete(ws.data.id);
        state.socketTargets.delete(ws.data.id);
        ensurePolling();
      },
      async message(ws, message) {
        const text = typeof message === 'string' ? message : Buffer.from(message).toString('utf8');
        const payload = JSON.parse(text) as { type?: string; targets?: string[]; includeLatest?: boolean };
        if (payload.type !== 'subscribe') {
          ws.send(JSON.stringify({ type: 'error', message: 'Unsupported message type' }));
          return;
        }

        const parsedTargets = (payload.targets ?? []).map((target) => parseTarget(target));
        const normalizedTargets = parsedTargets.map((target) => formatTarget(target));
        state.subscriptionsBySocket.set(ws.data.id, new Set(normalizedTargets));
        state.socketTargets.set(ws.data.id, parsedTargets);
        ws.data.includeLatest = payload.includeLatest ?? false;
        if (ws.data.includeLatest) {
          state.includeLatest = true;
          state.initialLatestSent = false;
        }
        ensurePolling();
        sendSubscribedEvent(ws, normalizedTargets);
      },
    },
    error(error) {
      return new Response(error.message, { status: 500 });
    },
  });

  state.server = server;

  process.on('SIGINT', () => {
    stopPolling();
    server.stop(true);
  });

  process.on('SIGTERM', () => {
    stopPolling();
    server.stop(true);
  });

  return server;
}

function publishIfChanged(
  state: DaemonState,
  target: SubscriptionTarget,
  snapshot: PipelineSnapshot,
): void {
  const key = `${snapshot.projectSlug}:${snapshot.number}`;
  const previous = state.lastStateByPipeline.get(key);

  // Determine if this is a latest/initial event
  const isLatest = state.includeLatest && !state.initialLatestSent;
  if (isLatest) {
    state.initialLatestSent = true;
    state.includeLatest = false;
  }

  // Skip if state hasn't changed (unless this is a latest event)
  if (previous === snapshot.state && !isLatest) {
    return;
  }

  state.lastStateByPipeline.set(key, snapshot.state);

  const event = toStreamEvent(target, snapshot);
  if (isLatest) {
    event.isLatest = true;
  }

  state.server?.publish(
    'events',
    JSON.stringify({
      type: 'event',
      payload: event,
    }),
  );
}

async function handleProjects(client: CircleCiClient, url: URL): Promise<Response> {
  try {
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const projects = await client.listProjects();
    const items = projects
      .filter((project) => project.displayName.toLowerCase().includes(query))
      .map((project) => ({
        ...project,
        target: `pipelines/${project.provider}/${project.org}/${project.project}`,
      }));
    return Response.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

async function handleLogin(
  req: Request,
  client: CircleCiClient,
  state: DaemonState,
): Promise<Response> {
  try {
    const payload = (await req.json()) as { token?: string };
    const token = payload.token?.trim();
    if (!token) {
      return new Response('Token is required', { status: 400 });
    }
    await client.validateToken(token);
    writeStoredToken(token);
    state.token = token;
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, 401);
  }
}

async function handleAwaitCompletion(req: Request, client: CircleCiClient): Promise<Response> {
  try {
    const payload = (await req.json()) as { target?: string; timeoutMs?: number };
    const parsed = parseTarget(payload.target ?? '');
    if (parsed.kind !== 'pipeline') {
      return new Response('await-completion requires a pipeline target', { status: 400 });
    }

    const snapshot = await client.awaitPipeline(
      parsed,
      payload.timeoutMs ?? 0,
      getPollIntervalMs(),
    );
    return Response.json({ snapshot });
  } catch (error) {
    if (error instanceof AwaitTimeoutError) {
      return new Response(error.message, { status: 408 });
    }
    return jsonError(error);
  }
}

function jsonError(error: unknown, status = 500): Response {
  return Response.json(
    { error: error instanceof Error ? error.message : 'Unknown error' },
    { status },
  );
}
