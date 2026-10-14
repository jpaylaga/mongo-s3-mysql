import { Command } from 'commander';
import confirm from '#cli/confirm';
import parseList from '#cli/parseList';
import printSummary from '#cli/printSummary';
import resolveContext from '#cli/resolveContext';
import verifyClosing from '#cli/verifyClosing';
import type { VerifyResult } from '#types';
import verify from '#verify/verify';

interface VerifyFlags {
  batchId?: string;
  all?: boolean;
  write: boolean;
  dryRun?: boolean;
}

/**
 * One row per collection; damage and unreadable chunks are separate columns because they map to
 * different exit codes.
 */
function rows(result: VerifyResult): Record<string, unknown>[] {
  const byCollection = new Map<
    string,
    {
      collection: string;
      checked: number;
      ok: number;
      damaged: number;
      unreadable: number;
      lines: number;
    }
  >();

  for (const check of result.checks) {
    const row = byCollection.get(check.collection) ?? {
      collection: check.collection,
      checked: 0,
      ok: 0,
      damaged: 0,
      unreadable: 0,
      lines: 0,
    };

    row.checked += 1;
    row.lines += check.lines;

    if (check.operational !== undefined) row.unreadable += 1;
    else if (check.ok) row.ok += 1;
    else row.damaged += 1;

    byCollection.set(check.collection, row);
  }

  return [...byCollection.values()].sort((a, b) => a.collection.localeCompare(b.collection));
}

export default function verifyCommand(): Command {
  return new Command('verify')
    .description(
      're-read every part of the selected chunks and check sizes, checksums and line counts'
    )
    .option('--batch-id <ids>', 'comma-separated batch ids (default: every batch)')
    .option('--all', 're-check chunks whose parse-check already passed')
    .option('--no-write', 'write nothing to S3')
    .option('--dry-run', 'print totals; read nothing')
    .action(async (opts: VerifyFlags, command: Command) => {
      const cli = await resolveContext(command, { s3: true });

      try {
        if (cli.store === undefined) throw new Error('verify needs the S3 client');

        const result = await verify({
          ctx: cli.ctx,
          store: cli.store,
          collections: cli.collections,
          narrowed: cli.globals.collections !== undefined,
          batchIds: parseList(opts.batchId),
          all: opts.all,
          write: opts.write,
          dryRun: opts.dryRun,
          forceUnlock: cli.globals.forceUnlock,
          confirm: question => confirm(question, cli.globals.yes),
        });

        printSummary(
          result,
          rows(result),
          cli.globals.json,
          verifyClosing(result, opts.dryRun, cli.globals)
        );

        process.exitCode = result.exitCode;
      } finally {
        await cli.close();
      }
    });
}
