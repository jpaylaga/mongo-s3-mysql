import { setTimeout as sleep } from 'node:timers/promises';
import type { RunContext } from '../types.js';
import backoffDelay from './backoffDelay.js';
import classifyError from './classifyError.js';
import errorMessage from './errorMessage.js';
import msmError from './msmError.js';
import redact from './redact.js';

/**
 * Runs `fn` up to `retry.attempts` times for operation-level transient failures (an S3 SlowDown, a Mongo
 * failover, a lost MySQL connection). Anything else, the last attempt, and an abort propagate at once.
 */
export default async function withRetry<T>(
  ctx: RunContext,
  op: { source: 'mongo' | 's3' | 'mysql'; name: string },
  fn: (attempt: number) => Promise<T>,
): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs } = ctx.config.retry;
  for (let attempt = 1; ; attempt += 1) {
    if (ctx.signal.aborted) throw msmError('interrupted', `${op.name}: interrupted`);
    try {
      return await fn(attempt);
    } catch (err) {
      const klass = classifyError(err);
      if (!klass.retriable || klass.fatal || attempt >= attempts || ctx.signal.aborted) throw err;
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      ctx.emit({ type: 'retry', command: ctx.command, source: op.source, name: op.name, attempt, delayMs,
        error: redact(errorMessage(err), ctx.secrets) });
      try {
        await sleep(delayMs, undefined, { signal: ctx.signal });
      } catch {
        throw msmError('interrupted', `${op.name}: interrupted`, { cause: err });
      }
    }
  }
}
