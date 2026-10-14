import lineHasId from '../ejson/lineHasId.js';
import type { ChunkManifest, CountsRecord, ParseCheckRecord } from '../types.js';

/**
 * The two validation records export writes before the manifest: the real key sets plus `source_count_after`.
 * Booleans stay null when there was nothing to test (empty or manifest-only chunks); verify starts from the
 * same records and fills in the rest. The first-line rule is `lineHasId`, so both commands describe a line
 * that is not JSON the same way: not parseable, and `_id` unjudged (null).
 */
export default function buildValidation(manifest: ChunkManifest, firstLine: string | null, gzipOk: boolean | null): { counts: CountsRecord; parseCheck: ParseCheckRecord } {
  const counts: CountsRecord = {
    run_id: manifest.run_id, collection: manifest.collection, mode: manifest.mode, count_source: manifest.count_source,
    source_count: manifest.source_count, exported_count: manifest.exported_count, matches: manifest.counts_match,
    ...(manifest.source_count_after === undefined ? {} : { source_count_after: manifest.source_count_after }),
  };
  const hasId = firstLine === null ? null : lineHasId(firstLine);
  const parseable = firstLine === null ? null : hasId !== null;
  const parseCheck: ParseCheckRecord = {
    run_id: manifest.run_id, collection: manifest.collection, mode: manifest.mode,
    gzip_test: gzipOk, first_line_parseable: parseable, first_line_has_id: hasId,
    manifest_only: manifest.mode === 'manifest-only',
  };
  return { counts, parseCheck };
}
