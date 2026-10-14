import exitCodes from '../cli/exitCodes.js';
import type { ExitCode } from '../types.js';

/** The exit code of an interrupted run: 143 after SIGTERM, 130 after SIGINT or any other abort. */
export default function abortExitCode(signal: AbortSignal): ExitCode {
  return signal.reason === 'SIGTERM' ? exitCodes.sigterm : exitCodes.sigint;
}
