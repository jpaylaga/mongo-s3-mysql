import type {
  LedgerRow,
  LoadCandidate,
  ParseCheckRecord,
  ResolvedManifest,
  SelectOptions,
  SkippedChunk,
} from '#types';

/** A parse-check proves a chunk only when it passed for the exact manifest body that exists now. */
const verified = (check: ParseCheckRecord | null | undefined, manifestSha256: string): boolean =>
  check !== null &&
  check !== undefined &&
  check.ok === true &&
  check.manifest_sha256 === manifestSha256;

/**
 * Which discovered chunks a load should touch (first match per manifest). `incomplete` skips make
 * the run exit 2 because the archive or the ledger needs attention; a `warn` skip only means the
 * operator changed the mapping and has to say `--reload` to apply it; an `info` skip is routine
 * resume.
 */
export default function selectChunks(
  manifests: readonly ResolvedManifest[],
  checks: ReadonlyMap<string, ParseCheckRecord | null>,
  ledger: readonly LedgerRow[],
  mappingSha: string,
  opts: SelectOptions
): { candidates: LoadCandidate[]; skipped: SkippedChunk[] } {
  const rows = new Map(ledger.map(r => [r.chunk_run_id, r]));
  const candidates: LoadCandidate[] = [];
  const skipped: SkippedChunk[] = [];

  for (const resolved of manifests) {
    const row = rows.get(resolved.runId);
    const loaded = row !== undefined && row.status === 'loaded';
    const sameManifest = row !== undefined && row.manifest_sha256 === resolved.sha256;
    const sameMapping = row !== undefined && row.mapping_sha256 === mappingSha;

    const skip = (reason: string, severity: SkippedChunk['severity']) =>
      skipped.push({ resolved, reason, severity });

    if (loaded && !opts.reload && sameManifest && sameMapping) skip('already loaded', 'info');
    else if (!resolved.manifest.counts_match && !opts.allowMismatch)
      skip('counts did not match at export', 'incomplete');
    else if (!opts.allowUnverified && !verified(checks.get(resolved.runId), resolved.sha256))
      skip('unverified', 'incomplete');
    else if (loaded && !opts.reload && !sameManifest)
      skip('manifest changed after load; pass --reload', 'incomplete');
    else if (loaded && !opts.reload && !sameMapping)
      skip('loaded with another mapping; pass --reload', 'warn');
    else candidates.push({ resolved, reload: loaded });
  }

  return { candidates, skipped };
}
