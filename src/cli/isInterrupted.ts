import exitCodes from '#cli/exitCodes';

/**
 * Whether a result's exit code says the run was stopped by SIGINT or SIGTERM, so the closing hint
 * says to rerun.
 */
export default function isInterrupted(exitCode: number): boolean {
  return exitCode === exitCodes.sigint || exitCode === exitCodes.sigterm;
}
