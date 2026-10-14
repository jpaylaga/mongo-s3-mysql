import { Command } from 'commander';
import confirm from '#cli/confirm';
import isInterrupted from '#cli/isInterrupted';
import nextCommand from '#cli/nextCommand';
import type { NextGlobals } from '#cli/nextCommand';
import parseList from '#cli/parseList';
import printSummary from '#cli/printSummary';
import resolveContext from '#cli/resolveContext';
import load from '#load/load';
import type { LoadResult } from '#types';

interface LoadFlags {
  batchId?: string;
  createTables?: boolean;
  allowUnverified?: boolean;
  allowMismatch?: boolean;
  allowOlder?: boolean;
  reload?: boolean;
  loadRunId?: string;
  dryRun?: boolean;
}

function closing(result: LoadResult, dryRun: boolean | undefined, globals: NextGlobals): string {
  const load = (...args: string[]) => nextCommand(globals, 'load', args);

  if (dryRun) return `${load()} (without --dry-run) to load`;

  if (isInterrupted(result.exitCode)) return `${load()} again to resume from the ledger`;

  const skipped = result.outcomes.filter(
    o => o.status === 'skipped' && o.note !== 'already loaded'
  );

  if (result.outcomes.some(o => o.status === 'failed'))
    return `${load()} again for the failed chunks (the errors are in _msm_load_chunks.error)`;

  if (skipped.some(o => o.note === 'unverified'))
    return (
      `${nextCommand(globals, 'verify')}, then ${load()} again (or ` +
      `${load('--allow-unverified')})`
    );

  if (skipped.some(o => o.note?.startsWith('counts did not match')))
    return `re-export the flagged chunks, or ${load('--allow-mismatch')}`;

  if (skipped.some(o => o.note?.includes('--reload')))
    return `${load('--reload')} to apply the changed manifest or mapping`;

  return nextCommand(globals, 'reconcile');
}

export default function loadCommand(): Command {
  return new Command('load')
    .description('upsert archived chunks into the mapped MySQL tables, resumable per chunk')
    .option(
      '--batch-id <ids>',
      'comma-separated batch ids (default: every batch, oldest cutoff first)'
    )
    .option('--create-tables', 'create missing tables from the mappings')
    .option('--allow-unverified', 'load chunks without a passing parse-check')
    .option('--allow-mismatch', 'load chunks whose export counts did not match')
    .option('--allow-older', 'load a batch older than one already loaded')
    .option('--reload', 'reset and reload chunks already loaded')
    .option('--load-run-id <id>', 'value for the run id column')
    .option('--dry-run', 'print what would load; write nothing')
    .action(async (opts: LoadFlags, command: Command) => {
      const cli = await resolveContext(command, { s3: true, mysql: true });

      try {
        if (cli.store === undefined || cli.mysql === undefined)
          throw new Error('load needs the S3 and MySQL clients');

        const result = await load({
          ctx: cli.ctx,
          store: cli.store,
          mysql: cli.mysql,
          collections: cli.collections,
          batchIds: parseList(opts.batchId),
          createTables: opts.createTables,
          allowMismatch: opts.allowMismatch,
          allowUnverified: opts.allowUnverified,
          allowOlder: opts.allowOlder,
          reload: opts.reload,
          loadRunId: opts.loadRunId,
          dryRun: opts.dryRun,
          forceUnlock: cli.globals.forceUnlock,
          confirm: q => confirm(q, cli.globals.yes),
        });

        printSummary(
          result,
          result.perTable,
          cli.globals.json,
          closing(result, opts.dryRun, cli.globals)
        );

        process.exitCode = result.exitCode;
      } finally {
        await cli.close();
      }
    });
}
