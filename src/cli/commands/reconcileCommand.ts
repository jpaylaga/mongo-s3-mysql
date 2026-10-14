import { Command } from 'commander';
import reconcile from '../../reconcile/reconcile.js';
import type { DriftKind, ReconcileResult } from '../../types.js';
import confirm from '../confirm.js';
import escapeControl from '../escapeControl.js';
import exitCodes from '../exitCodes.js';
import isInterrupted from '../isInterrupted.js';
import nextCommand, { type NextGlobals } from '../nextCommand.js';
import parseList from '../parseList.js';
import printSummary from '../printSummary.js';
import resolveContext from '../resolveContext.js';

interface Opts { batchId?: string; deep?: boolean; showOk?: boolean; ignore?: string }

const driftKinds: readonly DriftKind[] = ['not_loaded', 'load_incomplete', 'manifest_changed', 'line_count', 'batch_incomplete',
  'table_count', 'chunk_count', 'orphan_chunk', 'missing_rows', 'unknown_rows', 'deep_distinct'];

/** A typo in --ignore must not silently turn exit 4 into exit 0, so unknown kinds are refused before anything runs. */
function parseIgnore(value: string | undefined): DriftKind[] {
  const kinds = parseList(value);
  const unknown = kinds.filter((k) => !driftKinds.includes(k as DriftKind));
  if (unknown.length > 0) throw new Error(`--ignore: unknown drift kind ${unknown.join(', ')}; known: ${driftKinds.join(', ')}`);
  return kinds as DriftKind[];
}

/** One row per drift for the table on stdout; the detail (which carries archive ids) is escaped and clipped so the table stays readable, the JSON result keeps it whole. */
function driftRows(result: ReconcileResult): Record<string, unknown>[] {
  return result.drifts.map((d) => ({
    table: d.table, kind: d.kind, chunk: d.chunk ?? '', expected: d.expected ?? '', actual: d.actual ?? '',
    detail: escapeControl(d.detail.length > 120 ? `${d.detail.slice(0, 117)}...` : d.detail),
  }));
}

function closing(result: ReconcileResult, ignore: DriftKind[], globals: NextGlobals): string {
  if (isInterrupted(result.exitCode)) return `${nextCommand(globals, 'reconcile')} again to finish the comparison`;
  if (result.exitCode !== exitCodes.drift) {
    if (result.perTable.length === 0) return `${nextCommand(globals, 'infer')} and ${nextCommand(globals, 'load')} before reconciling`;
    return result.perTable.every((p) => p.deep) ? 'the tables hold what the archive holds' : `${nextCommand(globals, 'reconcile', ['--deep'])} proves coverage row by row`;
  }
  const counted = result.drifts.filter((d) => !ignore.includes(d.kind));
  const kinds = [...new Set(counted.map((d) => d.kind))];
  const chunks = [...new Set(counted.map((d) => d.chunk).filter((c): c is string => c !== null))];
  if (kinds.some((k) => k === 'table_count' || k === 'missing_rows' || k === 'not_loaded' || k === 'load_incomplete' || k === 'manifest_changed' || k === 'line_count')) {
    return `${nextCommand(globals, 'load', ['--reload', '--batch-id', '<affected batches>'])} re-applies the affected chunks${chunks.length > 0 ? ` (${chunks.length} named above)` : ''}; rows deleted on purpose: ${nextCommand(globals, 'reconcile', ['--ignore', kinds.join(',')])} accepts them`;
  }
  return `inspect the drifts above; ${nextCommand(globals, 'reconcile', ['--ignore', kinds.join(',')])} accepts them`;
}

export default function reconcileCommand(): Command {
  return new Command('reconcile')
    .description('compare manifests, the load ledger and the tables; exit 4 on drift')
    .option('--batch-id <ids>', 'comma-separated batch ids (default: every batch in the ledger)')
    .option('--deep', 'read every part and prove row coverage')
    .option('--show-ok', 'list chunks without drift too')
    .option('--ignore <kinds>', 'comma-separated drift kinds that do not fail the run')
    .action(async (opts: Opts, command: Command) => {
      const ignore = parseIgnore(opts.ignore);
      const cli = await resolveContext(command, { s3: true, mysql: true });
      try {
        if (cli.store === undefined || cli.mysql === undefined) throw new Error('reconcile needs the S3 and MySQL clients');
        const result = await reconcile({
          ctx: cli.ctx, store: cli.store, mysql: cli.mysql, collections: cli.collections,
          narrowed: cli.globals.collections !== undefined,
          batchIds: parseList(opts.batchId), deep: opts.deep, showOk: opts.showOk, ignore,
          forceUnlock: cli.globals.forceUnlock, confirm: (q) => confirm(q, cli.globals.yes),
        });
        if (!cli.globals.json && result.drifts.length > 0) console.table(driftRows(result));
        printSummary(result, result.perTable, cli.globals.json, closing(result, ignore, cli.globals));
        process.exitCode = result.exitCode;
      } finally {
        await cli.close();
      }
    });
}
