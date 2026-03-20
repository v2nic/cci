import { runCli, shouldStartDaemon } from './cli';
import { startDaemon } from './daemon';

const args = Bun.argv.slice(2);

if (shouldStartDaemon(args)) {
  await startDaemon();
} else {
  const exitCode = await runCli(args);
  process.exit(exitCode);
}
