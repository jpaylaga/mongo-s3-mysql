import { Command } from 'commander';
import confirm from '#cli/confirm';
import nextCommand from '#cli/nextCommand';
import type { NextGlobals } from '#cli/nextCommand';
import printSummary from '#cli/printSummary';
import resolveContext from '#cli/resolveContext';
import exportArchive from '#export/exportArchive';
import type { ExportResult } from '#types';

interface Opts {
  batchId?: string;
  since?: string;
  cutoff?: string;
  includeRest?: boolean;
  dryRun?: boolean;
}

const closing = (result: ExportResult, globals: NextGlobals): string => {
  if (result.status === 'planned')
    return `${nextCommand(globals, 'export', ['--batch-id', result.batchId])} (without --dry-run)`;

  if (result.status === 'complete')
    return nextCommand(globals, 'verify', ['--batch-id', result.batchId]);

  return (
    `${nextCommand(globals, 'export', ['--batch-id', result.batchId])} (resumes the ` +
    'unfinished chunks)'
  );
};

export default function exportCommand(): Command {
  return new Command('export')
    .description('archive collections to S3 as gzipped Extended JSON chunks with manifests')
    .option('--batch-id <id>', 'resume or name a batch')
    .option('--since <iso|last>', 'delta from an instant, or from the last complete batch')
    .option(
      '--cutoff <iso>',
      'upper bound of the batch (default: now minus safetyLagMinutes, floored to the hour)'
    )
    .option('--include-rest', 'export documents outside every window')
    .option('--dry-run', 'print the plan; write nothing')
    .action(async (opts: Opts, command: Command) => {
      const cli = await resolveContext(command, { mongo: true, s3: true });

      try {
        if (cli.mongo === undefined || cli.store === undefined)
          throw new Error('export needs the MongoDB and S3 clients');

        const result = await exportArchive({
          ctx: cli.ctx,
          mongo: cli.mongo,
          store: cli.store,
          collections: cli.collections,
          batchId: opts.batchId,
          since: opts.since,
          cutoff: opts.cutoff,
          includeRest: opts.includeRest,
          dryRun: opts.dryRun,
          forceUnlock: cli.globals.forceUnlock,
          confirm: q => confirm(q, cli.globals.yes),
        });

        printSummary(result, result.perCollection, cli.globals.json, closing(result, cli.globals));
        process.exitCode = result.exitCode;
      } finally {
        await cli.close();
      }
    });
}
