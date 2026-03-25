import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = Number(process.env.CCI_PORT ?? '2243');
export const DEFAULT_HOST = '127.0.0.1';
export const HEALTHCHECK_TIMEOUT_MS = Number(process.env.CCI_HEALTHCHECK_TIMEOUT_MS ?? '150');
export const DAEMON_START_TIMEOUT_MS = Number(process.env.CCI_DAEMON_START_TIMEOUT_MS ?? '4000');
export const RECENT_PIPELINES_LIMIT = Number(process.env.CCI_RECENT_PIPELINES_LIMIT ?? '20');

export function getPollIntervalMs(): number {
  return Number(process.env.CCI_POLL_INTERVAL_MS ?? '5000');
}

export function getIdleStopMs(): number {
  return Number(process.env.CCI_IDLE_STOP_MS ?? '300000');
}

export function getCircleCiBaseUrl(): string {
  return process.env.CCI_CIRCLECI_BASE_URL ?? 'https://circleci.com/api/v2';
}

export function getHomeDirectory(): string {
  return process.env.CCI_HOME ?? os.homedir();
}

export function getTokenFilePath(): string {
  return path.join(getHomeDirectory(), '.circleci', 'token');
}

export function getTokenDirectoryPath(): string {
  return path.dirname(getTokenFilePath());
}
