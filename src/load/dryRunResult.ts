import exitCodes from '#cli/exitCodes';
import formatCount from '#runtime/formatCount';
import type { ChunkOutcome, LoadResult, LoadSelection } from '#types';

/**
 * The dry run's report: every decision of the plan, the DDL that would run, the totals; nothing
 * written.
 */
export default function dryRunResult(
  info: (message: string) => void,
  loadRunId: string,
  selections: LoadSelection[],
  ddl: string[],
  byTable: Map<string, Set<string>>,
  skippedOutcomes: ChunkOutcome[]
): LoadResult {
  const candidates = selections.flatMap(s => s.candidates);
  const docs = candidates.reduce((sum, c) => sum + c.resolved.manifest.exported_count, 0);

  for (const { batch, candidates: cands, skipped } of selections) {
    for (const c of cands) info(`load    ${c.resolved.runId}${c.reload ? ' (reload)' : ''}`);

    for (const s of skipped) info(`skip    ${s.resolved.runId}: ${s.reason}`);

    info(
      `batch ${batch.id}: ${formatCount(cands.length)} chunks to load, ` +
        `${formatCount(skipped.length)} skipped`
    );
  }

  for (const statement of ddl) info(`would run: ${statement.split('\n')[0]} ...`);

  info(
    `dry run: ~${formatCount(docs)} documents from ` +
      `${formatCount(candidates.length)} chunks into ` +
      `${[...byTable.keys()].join(', ') || 'no tables'}; nothing written`
  );

  const perTable = [...byTable].map(([table, runIds]) => ({
    table,
    chunks: runIds.size,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    rejected: 0,
  }));

  return { loadRunId, outcomes: skippedOutcomes, perTable, exitCode: exitCodes.ok };
}
