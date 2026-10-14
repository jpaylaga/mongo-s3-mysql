import exitCodes from '#cli/exitCodes';
import type { ExitCode } from '#types';

/** The exit code of an interrupted run: 143 after SIGTERM, 130 after SIGINT or any other abort. */
export default function abortExitCode(signal: AbortSignal): ExitCode {
  return signal.reason === 'SIGTERM' ? exitCodes.sigterm : exitCodes.sigint;
}
