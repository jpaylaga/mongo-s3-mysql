import type { FailureCode, MsmError } from '../types.js';

/**
 * A failure the tool classified itself. `retriable` null leaves the decision to `classifyError`
 * (only `insert_race` retries by default); `fatal` stops the whole run instead of one chunk.
 */
export default function msmError(
  code: FailureCode,
  message: string,
  options: { cause?: unknown; retriable?: boolean; fatal?: boolean } = {},
): MsmError {
  const err = new Error(message, options.cause === undefined ? undefined : { cause: options.cause }) as MsmError;
  err.name = 'MsmError';
  err.msmCode = code;
  err.retriable = options.retriable ?? null;
  err.fatal = options.fatal ?? false;
  return err;
}
