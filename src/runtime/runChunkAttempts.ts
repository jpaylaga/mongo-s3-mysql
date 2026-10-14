import { setTimeout as sleep } from 'node:timers/promises';
import type { ChunkOutcome, RunContext } from '../types.js';
import backoffDelay from './backoffDelay.js';
import classifyError from './classifyError.js';
import errorMessage from './errorMessage.js';
import msmError from './msmError.js';
import redact from './redact.js';

/**
 * Chunk-level retries: a chunk attempt that throws restarts the whole chunk, which is why the
 * wait is four times the operation backoff. Fatal errors rethrow so the orchestrator can stop every chunk.
 */
export default async function runChunkAttempts(
  ctx: RunContext,
  chunk: { chunk: string; collection: string },
  attempts: number,
  fn: (attempt: number) => Promise<ChunkOutcome>,
): Promise<ChunkOutcome> {
  const { baseDelayMs, maxDelayMs } = ctx.config.retry;
  const interrupted = (): ChunkOutcome => ({ chunk: chunk.chunk, collection: chunk.collection, status: 'interrupted', code: 'interrupted' });
  for (let attempt = 1; ; attempt += 1) {
    if (ctx.signal.aborted) return interrupted();
    try {
      return await fn(attempt);
    } catch (err) {
      const klass = classifyError(err);
      if (klass.aborted || ctx.signal.aborted) return interrupted();
      if (klass.fatal) {
        // The second ENOSPC of the process: the reservation math is wrong for this box, said in the documented words.
        if (klass.code === 'disk' && (err as { code?: unknown }).code === 'ENOSPC') throw msmError('disk', 'out of space twice; lower concurrency or partMaxBytesMb', { cause: err, fatal: true });
        throw err;
      }
      const message = redact(errorMessage(err), ctx.secrets);
      if (!klass.chunkRetriable || attempt >= attempts) {
        return { chunk: chunk.chunk, collection: chunk.collection, status: 'failed', code: klass.code, error: message };
      }
      const delayMs = backoffDelay(attempt, 4 * baseDelayMs, maxDelayMs);
      ctx.emit({ type: 'chunk', command: ctx.command, chunk: chunk.chunk, status: 'retry', detail: `attempt ${attempt} failed (${klass.code}): ${message}; retry in ${(delayMs / 1000).toFixed(1)}s` });
      try {
        await sleep(delayMs, undefined, { signal: ctx.signal });
      } catch {
        return interrupted();
      }
    }
  }
}
