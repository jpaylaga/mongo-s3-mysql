import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import printSummary from '#cli/printSummary';
import type { CliContext } from '#types';

// Resolved from this file so the same path works from src/ under vitest and from dist/ when
// installed.
const example = new URL('../../../examples/mongo-s3-mysql.config.json', import.meta.url);

/**
 * The example config with an empty `collections` list (the next documented step is
 * `inventory --write-config`, which refuses to replace a non-empty list without `--force`) and
 * without `mysql.caFile`: the example's bundle is a file the user does not have, and a missing file
 * would fail the first `load` with ENOENT. The full example stays in docs/configuration.md.
 */
async function initialConfig(): Promise<string> {
  const raw = JSON.parse(await readFile(fileURLToPath(example), 'utf8')) as Record<string, unknown>;
  const { caFile: _caFile, ...mysql } = (raw.mysql ?? {}) as Record<string, unknown>;

  return `${JSON.stringify({ ...raw, mysql, collections: [] }, null, 2)}\n`;
}

export default function initCommand(): Command {
  return new Command('init')
    .description('write a starter config file to -c')
    .option('--force', 'overwrite an existing file')
    .action(async (opts: { force?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<CliContext['globals']>();
      const dest = globals.config;

      if (!opts.force && existsSync(dest))
        throw new Error(`${dest} already exists; pass --force to overwrite it`);

      await writeFile(dest, await initialConfig(), 'utf8');

      if (!globals.json) process.stdout.write(`wrote ${dest}\n`);

      printSummary(
        { wrote: dest },
        [],
        globals.json,
        `edit mongo, s3 and mysql in ${dest}, set MSM_MONGO_URI, then run: ` +
          'mongo-s3-mysql inventory --write-config'
      );
    });
}
