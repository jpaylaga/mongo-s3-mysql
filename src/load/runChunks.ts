import loadChunk from '#load/loadChunk';
import markChunkFailed from '#mysql/markChunkFailed';
import errorMessage from '#runtime/errorMessage';
import formatCount from '#runtime/formatCount';
import mapLimit from '#runtime/mapLimit';
import redact from '#runtime/redact';
import runChunkAttempts from '#runtime/runChunkAttempts';
import type { ChunkOutcome, LoadRun, LoadSelection } from '#types';

/**
 * The chunk phase of a load: batch after batch (oldest cutoff first), `load.concurrency` chunks at
 * a time, each through `runChunkAttempts`. A chunk that fails for good is recorded in its ledger
 * row. A fatal error (a lost lock, a shape problem found mid-run) aborts `local`, which every other
 * chunk is listening to, and is returned as `fatal` once they have stopped; the caller decides what
 * outranks what.
 */
export default async function runChunks(
  run: LoadRun,
  selections: LoadSelection[],
  local: AbortController,
  tableFor: (collection: string) => string
): Promise<{ outcomes: ChunkOutcome[]; fatal: unknown; docs: number }> {
  const { ctx, mysql } = run;
  const { concurrency, chunkAttempts } = ctx.config.load;
  const outcomes: ChunkOutcome[] = [];
  let fatal: unknown = null;
  let done = 0;
  let docs = 0;
  const total = selections.reduce((sum, s) => sum + s.candidates.length, 0);

  try {
    for (const { batch, candidates } of selections) {
      if (candidates.length === 0) continue;

      ctx.emit({
        type: 'info',
        command: ctx.command,
        message: `batch ${batch.id}: loading ${formatCount(candidates.length)} chunks`,
      });

      await mapLimit(candidates, concurrency, async cand => {
        let outcome: ChunkOutcome;

        try {
          outcome = await runChunkAttempts(
            ctx,
            { chunk: cand.resolved.runId, collection: cand.resolved.collection },
            chunkAttempts,
            attempt => loadChunk(run, cand, attempt)
          );
        } catch (err) {
          fatal ??= err;
          local.abort(err);

          throw err;
        }

        outcomes.push(outcome);
        done += 1;
        docs += outcome.docs ?? 0;

        if (outcome.status === 'failed') {
          ctx.emit({
            type: 'warn',
            command: ctx.command,
            message: `${cand.resolved.runId} failed (${outcome.code}): ${outcome.error ?? ''}`,
          });

          await markChunkFailed(
            mysql.pool,
            tableFor(outcome.collection),
            outcome.chunk,
            outcome.error ?? outcome.code ?? 'failed',
            ctx.secrets
          ).catch((err: unknown) =>
            ctx.emit({
              type: 'warn',
              command: ctx.command,
              message:
                `${outcome.chunk}: could not record the failure ` +
                `(${redact(errorMessage(err), ctx.secrets)})`,
            })
          );
        }

        ctx.emit({ type: 'progress', command: ctx.command, done, total, docs });
      });
    }
  } catch (err) {
    fatal ??= err;
  }

  return { outcomes, fatal, docs };
}
