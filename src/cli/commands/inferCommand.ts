import { basename, resolve } from 'node:path';
import { Command } from 'commander';
import nextCommand from '#cli/nextCommand';
import type { NextGlobals } from '#cli/nextCommand';
import printSummary from '#cli/printSummary';
import resolveContext from '#cli/resolveContext';
import infer from '#infer/infer';
import identifierSchema from '#mapping/identifierSchema';
import timeZoneSchema from '#mapping/timeZoneSchema';
import type { InferResult } from '#types';

interface Opts {
  batchId?: string;
  out?: string;
  table?: string;
  keyColumn: string;
  runIdColumn?: string;
  chunkColumn?: string;
  extraColumn?: string;
  timezone: string;
  childTables?: boolean;
  force?: boolean;
}

/**
 * Flag values become MySQL identifiers verbatim, so a bad one is refused before any S3 read, by the
 * mapping's own rule.
 */
function assertIdentifier(flag: string, value: string | undefined): void {
  if (value === undefined) return;

  const result = identifierSchema.safeParse(value);

  if (!result.success)
    throw new Error(
      `${flag} ${JSON.stringify(value)}: ${result.error.issues[0]?.message ?? 'not an identifier'}`
    );
}

function assertTimeZone(tz: string): void {
  const result = timeZoneSchema.safeParse(tz);

  if (!result.success)
    throw new Error(
      `--timezone ${JSON.stringify(tz)}: not ${result.error.issues[0]?.message ?? 'a time zone'}`
    );
}

function rows(result: InferResult): Record<string, unknown>[] {
  return result.review.map(r => ({
    collection: r.collection,
    review: r.lines.length,
    mapping: result.files.find(f => basename(f) === `${r.collection}.mapping.json`) ?? '',
  }));
}

function closing(result: InferResult, globals: NextGlobals): string {
  if (result.files.length === 0)
    return 'nothing written: no documents found for the selected collections';

  const lines = result.review.reduce((sum, r) => sum + r.lines.length, 0);

  return (
    `review the mapping files (${lines} review lines), then ` +
    `${nextCommand(globals, 'load', ['--create-tables'])}, or create the tables from ` +
    'the .sql files first'
  );
}

export default function inferCommand(): Command {
  return new Command('infer')
    .description('sample an archive and write a mapping file plus CREATE TABLE DDL per collection')
    .option('--batch-id <id>', 'batch to sample (default: newest)')
    .option('--out <dir>', 'output directory (default: mappingsDir)')
    .option('--table <t>', 'target table name (one collection only)')
    .option('--key-column <c>', 'key column name', 'mongo_id')
    .option('--run-id-column <c>', 'load run id column')
    .option('--chunk-column <c>', 'ledger chunk id column')
    .option('--extra-column <c>', 'JSON column for unmapped fields')
    .option('--timezone <tz>', 'wall-clock zone for datetime columns', 'UTC')
    .option('--child-tables', 'arrays of objects become child tables')
    .option('--force', 'overwrite existing mapping and DDL files')
    .action(async (opts: Opts, command: Command) => {
      assertIdentifier('--table', opts.table);
      assertIdentifier('--key-column', opts.keyColumn);
      assertIdentifier('--run-id-column', opts.runIdColumn);
      assertIdentifier('--chunk-column', opts.chunkColumn);
      assertIdentifier('--extra-column', opts.extraColumn);
      assertTimeZone(opts.timezone);

      const cli = await resolveContext(command, { s3: true });

      try {
        if (cli.store === undefined) throw new Error('infer needs the S3 client');

        if (opts.table !== undefined && cli.collections.length !== 1)
          throw new Error('--table applies to exactly one collection; pass -C <name>');

        const result = await infer({
          ctx: cli.ctx,
          store: cli.store,
          collections: cli.collections,
          batchId: opts.batchId,
          outDir: opts.out === undefined ? cli.ctx.config.mappingsDir : resolve(opts.out),
          force: opts.force,
          build: {
            table: opts.table,
            keyColumn: opts.keyColumn,
            runIdColumn: opts.runIdColumn ?? null,
            chunkColumn: opts.chunkColumn ?? null,
            extraColumn: opts.extraColumn ?? null,
            timezone: opts.timezone,
            childTables: opts.childTables ?? false,
            minPresence: cli.ctx.config.infer.minPresence,
            maxColumns: cli.ctx.config.infer.maxColumns,
          },
        });

        printSummary(result, rows(result), cli.globals.json, closing(result, cli.globals));
        process.exitCode = result.exitCode;
      } finally {
        await cli.close();
      }
    });
}
