import recordSchemas from '#layout/recordSchemas';
import formatUtc from '#runtime/formatUtc';
import type { ChunkManifest, ManifestInput } from '#types';

/**
 * The commit record, keyed in the original exporter's order so a single-part chunk is
 * indistinguishable from one the production exporter wrote. `parts[]` appears only when there are
 * several parts; `file` is always part 1.
 */
export default function buildChunkManifest(input: ManifestInput): ChunkManifest {
  const { plan, parts } = input;
  const manifestOnly = plan.mode === 'manifest-only';
  const first = parts[0] ?? null;

  const record: Record<string, unknown> = {
    run_id: plan.runId,
    ...input.partition,
    collection: plan.collection,
    mode: plan.mode,
    filter: plan.filterRecord,
    format: manifestOnly ? 'manifest_only' : 'canonical_extended_jsonl_gzip',
    count_source: 'countDocuments',
    source_count: input.sourceCount,
    exported_count: input.exported,
    counts_match:
      input.sourceCount === input.sourceCountAfter && input.sourceCountAfter === input.exported,
    source_count_after: input.sourceCountAfter,
    first_id: manifestOnly ? null : input.firstId,
    last_id: manifestOnly ? null : input.lastId,
    file:
      first === null
        ? null
        : { name: first.name, bytes: first.bytes, sha256: first.sha256, s3_uri: first.s3_uri },
    checksum_s3_uri: first === null ? null : first.checksum_s3_uri,
    ...(parts.length > 1
      ? {
          parts: parts.map(p => ({
            name: p.name,
            bytes: p.bytes,
            sha256: p.sha256,
            s3_uri: p.s3_uri,
            checksum_s3_uri: p.checksum_s3_uri,
            lines: p.lines ?? 0,
          })),
        }
      : {}),
    started_at: formatUtc(input.startedAt, 'offset'),
    completed_at: formatUtc(input.completedAt, 'offset'),
    schema_version: 1,
    tool: input.toolVersion,
  };

  // Parsing proves the record is one every reader accepts; the original object keeps the key order.
  recordSchemas.chunkManifest.parse(record);

  return record as ChunkManifest;
}
