import envSecrets from '#cli/envSecrets';
import escapeControl from '#cli/escapeControl';
import runSecrets from '#cli/runSecrets';
import errorMessage from '#runtime/errorMessage';
import redact from '#runtime/redact';

/**
 * The line cli.ts prints for an error nothing else caught. The context may not exist yet when it
 * fires (a bad config path, a missing env var), so the secrets are the values resolveContext
 * recorded for this run, when it got that far, plus every env value whose name conventionally holds
 * one. Several fatal messages embed text from S3 records (a batch id, a cutoff), so control
 * characters are escaped like in every event line.
 */
export default function fatalMessage(err: unknown): string {
  return (
    'mongo-s3-mysql: ' +
    `${escapeControl(redact(errorMessage(err), [...runSecrets.list(), ...envSecrets()]))}`
  );
}
