import { spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import {
  DAEMON_START_TIMEOUT_MS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  HEALTHCHECK_TIMEOUT_MS,
} from './config';
import { parseTarget } from './targets';
import { readStoredToken } from './token-store';
import type { AggregateStatus } from './types';

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'login':
      await ensureDaemon();
      return login();
    case 'await-completion':
      await ensureDaemon();
      return awaitCompletion(rest);
    case 'subscribe':
      await ensureDaemon();
      return subscribe(rest);
    case 'web':
      await ensureDaemon();
      output.write(`http://${DEFAULT_HOST}:${DEFAULT_PORT}\n`);
      return 0;
    case '--daemon':
      return 0;
    case '--help':
    case 'help':
    case undefined:
      printUsage();
      return 0;
    default:
      output.write(`Unknown command: ${command}\n`);
      printUsage();
      return 2;
  }
}

export function shouldStartDaemon(argv: string[]): boolean {
  return argv[0] === '--daemon';
}

async function login(): Promise<number> {
  const token = await readTokenFromStdin();
  if (!token) {
    output.write('Token is required\n');
    return 2;
  }

  const response = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    output.write(`${await response.text()}\n`);
    return 2;
  }

  output.write('Login succeeded\n');
  return 0;
}

async function awaitCompletion(args: string[]): Promise<number> {
  const target = args.find((value) => !value.startsWith('--'));
  if (!target) {
    output.write('A pipeline target is required\n');
    return 2;
  }

  parseTarget(target);

  const timeoutSecondsIndex = args.findIndex((value) => value === '--timeout');
  const timeoutSeconds =
    timeoutSecondsIndex >= 0 ? Number.parseInt(args[timeoutSecondsIndex + 1] ?? '0', 10) : 0;

  const response = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/await-completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, timeoutMs: timeoutSeconds * 1000 }),
  });

  if (response.status === 408) {
    output.write(`${await response.text()}\n`);
    return 4;
  }

  if (!response.ok) {
    output.write(`${await response.text()}\n`);
    return 2;
  }

  const payload = (await response.json()) as { snapshot: { state: AggregateStatus } };
  output.write(`${JSON.stringify(payload)}\n`);

  switch (payload.snapshot.state) {
    case 'success':
      return 0;
    case 'on_hold':
      return 3;
    case 'failed':
    case 'error':
    case 'canceled':
    case 'not_run':
    case 'unauthorized':
      return 1;
    default:
      return 0;
  }
}

async function subscribe(args: string[]): Promise<number> {
  const targets = args.filter((value) => !value.startsWith('--'));
  if (targets.length === 0) {
    output.write('At least one subscription target is required\n');
    return 2;
  }

  for (const target of targets) {
    parseTarget(target);
  }

  const includeLatest = args.includes('--include-latest');

  const socket = new WebSocket(`ws://${DEFAULT_HOST}:${DEFAULT_PORT}/ws`);
  const stream = new Promise<number>((resolve) => {
    socket.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : '';
      const payload = JSON.parse(text) as { type?: string; payload?: unknown };
      if (payload.type === 'event' || payload.type === 'system') {
        output.write(`${JSON.stringify(payload.payload)}\n`);
      }
    });

    socket.addEventListener('close', () => resolve(0), { once: true });
    socket.addEventListener('error', () => resolve(2), { once: true });
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
      once: true,
    });
  });

  socket.send(JSON.stringify({ type: 'subscribe', targets, includeLatest }));

  return await stream;
}

async function ensureDaemon(): Promise<void> {
  if (await isDaemonHealthy()) {
    return;
  }

  spawnSelfDaemon();

  const start = Date.now();
  while (Date.now() - start < DAEMON_START_TIMEOUT_MS) {
    if (await isDaemonHealthy()) {
      return;
    }
    await Bun.sleep(100);
  }

  throw new Error('Unable to start cci daemon');
}

async function isDaemonHealthy(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);
    const response = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

function spawnSelfDaemon(): void {
  const bunMain = Bun.main;
  const isTypescriptEntry = bunMain.endsWith('.ts');
  const executable = process.execPath;

  const child = isTypescriptEntry
    ? spawn(executable, [bunMain, '--daemon'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      })
    : spawn(executable, ['--daemon'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });

  child.unref();
}

async function readTokenFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      return (await rl.question('CircleCI token: ')).trim();
    } finally {
      rl.close();
    }
  }

  const text = await new Response(process.stdin as unknown as ReadableStream).text();
  return text.trim();
}

function printUsage(): void {
  output.write('cci <command>\n\n');
  output.write('Commands:\n');
  output.write('  login\n');
  output.write(
    '  await-completion pipelines/github/<org>/<project>/<pipeline_number> --timeout <seconds>\n',
  );
  output.write('  subscribe <target> [<target> ...]\n');
  output.write('  web\n');
  if (readStoredToken()) {
    output.write('Token file detected at ~/.circleci/token\n');
  }
}
