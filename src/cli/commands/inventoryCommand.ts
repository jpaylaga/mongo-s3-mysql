import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import nextCommand from '#cli/nextCommand';
import type { NextGlobals } from '#cli/nextCommand';
import printSummary from '#cli/printSummary';
import resolveContext from '#cli/resolveContext';
import loadConfig from '#config/loadConfig';
import parseConfig from '#config/parseConfig';
import readConfigObject from '#config/readConfigObject';
import isObject from '#ejson/isObject';
import inventory from '#inventory/inventory';
import mergeConfigCollections from '#inventory/mergeConfigCollections';
import formatCount from '#runtime/formatCount';
import type { CollectionInventory, InventoryReport } from '#types';

interface Options {
  all?: boolean;
  sample?: number;
  writeConfig?: boolean;
  force?: boolean;
}

const positiveInt = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value)) throw new InvalidArgumentError('must be a positive integer');

  return Number(value);
};

/** One table row per collection; skipped ones share the table so the reason is next to the name. */
function rows(report: InventoryReport): Record<string, unknown>[] {
  const of = (c: CollectionInventory) => ({
    collection: c.name,
    documents: formatCount(c.estimatedCount),
    ids: Object.entries(c.idTypes)
      .map(([type, count]) => `${type} ${count}`)
      .join(', '),
    strategy: c.suggestion.strategy,
    field: c.suggestion.field ?? '',
    window: c.suggestion.strategy === 'full-collection' ? '' : c.suggestion.window,
    reason: c.suggestion.reason,
  });

  const skipped = report.skipped.map(s => ({
    collection: s.name,
    documents: '',
    ids: '',
    strategy: '',
    field: '',
    window: '',
    reason: `skipped: ${s.reason}`,
  }));

  return [...report.collections.map(of), ...skipped];
}

/**
 * The config file as written, checked for `--force` before any connection is made so a refusal
 * costs nothing. `loadConfig` goes first: it validates with the position-only JSON error and the
 * secrets guard, so a typo next to a pasted secret never echoes the file text.
 */
async function readConfigFile(
  path: string,
  force: boolean | undefined
): Promise<Record<string, unknown>> {
  await loadConfig(path);

  const raw = await readConfigObject(path);

  if (!isObject(raw)) throw new Error(`${path}: not a JSON object`);

  const existing = Array.isArray(raw.collections) ? raw.collections.length : 0;

  if (existing > 0 && !force)
    throw new Error(`${path} lists ${existing} collections; pass --force to replace them`);

  return raw;
}

/**
 * Replaces `collections` in the config file with the suggestions; the result is validated before
 * anything is written.
 */
async function writeCollections(
  path: string,
  raw: Record<string, unknown>,
  report: InventoryReport,
  globals: NextGlobals
): Promise<string> {
  if (report.collections.length === 0) return 'no collection was inventoried; config unchanged';

  const next = mergeConfigCollections(raw, report);

  parseConfig(next, dirname(resolve(path)), path);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);

  return (
    `wrote ${(next.collections as unknown[]).length} collections into ${path}; then ` +
    `${nextCommand(globals, 'export', ['--dry-run'])}`
  );
}

export default function inventoryCommand(): Command {
  return new Command('inventory')
    .description('inspect collections and suggest an export strategy for each (read-only)')
    .option('--all', 'include collections the config does not list')
    .option('--sample <n>', 'newest documents sampled per collection (default: 1000)', positiveInt)
    .option('--write-config', 'write the suggestions into the config file')
    .option('--force', 'with --write-config: replace a non-empty collections list')
    .action(async (opts: Options, command: Command) => {
      const configPath = command.optsWithGlobals<{ config: string }>().config;
      const raw = opts.writeConfig ? await readConfigFile(configPath, opts.force) : null;
      const cli = await resolveContext(command, { mongo: true });

      try {
        if (cli.mongo === undefined) throw new Error('inventory needs the MongoDB client');

        const names =
          cli.globals.collections === undefined ? undefined : cli.collections.map(c => c.name);

        const report = await inventory({
          ctx: cli.ctx,
          mongo: cli.mongo,
          names,
          all: opts.all,
          sampleSize: opts.sample,
        });

        const closing = raw
          ? await writeCollections(configPath, raw, report, cli.globals)
          : 'edit collections in the config (or ' +
            `${nextCommand(cli.globals, 'inventory', ['--write-config'])}), then ` +
            `${nextCommand(cli.globals, 'export', ['--dry-run'])}`;

        printSummary(report, rows(report), cli.globals.json, closing);
        process.exitCode = report.exitCode;
      } finally {
        await cli.close();
      }
    });
}
