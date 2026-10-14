import type { FailureCode, MsmError } from '#types';

/** Whether `err` is a failure the tool classified itself, optionally with one specific code. */
export default function isMsmError(err: unknown, code?: FailureCode): err is MsmError {
  if (!(err instanceof Error) || typeof (err as MsmError).msmCode !== 'string') return false;

  return code === undefined || (err as MsmError).msmCode === code;
}
