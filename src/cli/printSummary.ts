import escapeControl from '#cli/escapeControl';
import escapeJsonControl from '#cli/escapeJsonControl';

/**
 * The command result on stdout: a table of rows plus a `next:` hint, or the whole result as one
 * JSON document with `--json` (then nothing else touches stdout). Redaction happened upstream:
 * results carry chunk ids, counts and already-redacted error strings. The hint can carry batch ids
 * from S3 manifests, so its control characters are escaped; the JSON document gets the C1 escapes
 * JSON.stringify leaves out.
 */
export default function printSummary(
  result: unknown,
  rows: Record<string, unknown>[],
  json: boolean | undefined,
  closing: string
): void {
  if (json) {
    process.stdout.write(`${escapeJsonControl(JSON.stringify(result, null, 2))}\n`);

    return;
  }

  if (rows.length > 0) console.table(rows);

  if (closing) process.stdout.write(`next: ${escapeControl(closing)}\n`);
}
