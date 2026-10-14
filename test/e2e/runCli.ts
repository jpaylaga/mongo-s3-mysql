import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Stack } from './startStack.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = fileURLToPath(new URL('dist/cli.js', new URL('../../', import.meta.url)));

let built: Promise<void> | null = null;

/**
 * `dist/cli.js` is what users run, so the e2e drives the built file. It is rebuilt once per
 * process, not only when missing: a stale dist would test yesterday's library code under today's
 * in-process steps.
 */
async function ensureBuilt(): Promise<void> {
  built ??= exec('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: root }).then(() => undefined);
  await built;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the CLI as a child process with the stack's config and secrets, `--yes` added, and returns
 * its exit code and output.
 */
export default async function runCli(stack: Stack, args: string[]): Promise<CliResult> {
  await ensureBuilt();

  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cliPath, '-c', stack.configPath, '-y', ...args],
      {
        cwd: stack.workDir,
        env: stack.env,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);

          return;
        }

        resolve({
          code: child.exitCode ?? (typeof error?.code === 'number' ? error.code : 0),
          stdout,
          stderr,
        });
      }
    );
  });
}
