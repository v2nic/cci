import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { getTokenDirectoryPath, getTokenFilePath } from './config';

export function readStoredToken(): string | null {
  const tokenFilePath = getTokenFilePath();
  if (!existsSync(tokenFilePath)) {
    return null;
  }

  const token = readFileSync(tokenFilePath, 'utf8').trim();
  return token.length > 0 ? token : null;
}

export function writeStoredToken(token: string): void {
  const tokenDirectoryPath = getTokenDirectoryPath();
  const tokenFilePath = getTokenFilePath();

  mkdirSync(tokenDirectoryPath, { recursive: true, mode: 0o700 });
  chmodSync(tokenDirectoryPath, 0o700);
  writeFileSync(tokenFilePath, `${token.trim()}\n`, { mode: 0o600 });
  chmodSync(tokenFilePath, 0o600);
}
