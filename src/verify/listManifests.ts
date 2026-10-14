import listChunkManifests from '#layout/listChunkManifests';
import formatUtc from '#runtime/formatUtc';
import mapLimit from '#runtime/mapLimit';
import toolVersion from '#runtime/toolVersion';
import type {
  ChunkCheck,
  InvalidRecord,
  Layout,
  ObjectStore,
  ResolvedManifest,
  RunContext,
} from '#types';
import recordError from '#verify/recordError';
import type { VerifyBatch } from '#verify/resolveBatches';

/**
 * A manifest that does not parse is a damaged record: a failing parse-check with the mode the run
 * id names. No counts record: the exporter's counts.json is the last copy of the chunk's counts and
 * must stay as it is.
 */
function recordCheck(
  ctx: RunContext,
  batchId: string,
  collection: string,
  invalid: InvalidRecord
): ChunkCheck {
  const error = recordError(invalid.message);

  return {
    runId: invalid.runId,
    batchId,
    collection,
    ok: false,
    lines: 0,
    errors: [error],
    parseCheck: {
      run_id: invalid.runId,
      collection,
      mode: invalid.id.mode,
      gzip_test: null,
      first_line_parseable: null,
      first_line_has_id: null,
      manifest_only: invalid.id.mode === 'manifest-only',
      ok: false,
      lines: 0,
      parse_errors: 0,
      missing_ids: 0,
      bytes_ok: null,
      sha256_ok: null,
      sidecar_ok: null,
      verified_at: formatUtc(ctx.now(), 'offset'),
      errors: [error],
      tool: toolVersion,
    },
  };
}

export interface ListedManifests {
  /** Per batch id, every chunk manifest of the counted collections that parsed. */
  listed: Map<string, ResolvedManifest[]>;
  /** The damaged manifests of the selected collections, as failing checks. */
  invalid: ChunkCheck[];
  /** Batches with at least one damaged chunk manifest, over every counted collection. */
  damagedBatches: Set<string>;
}

/**
 * Lists the chunk manifests of every batch over the `counted` collections (the completeness tally
 * covers every archived collection), reading them, and turns the ones that do not parse into
 * damaged checks for the `selected` collections, whose parts the run will read.
 */
export default async function listManifests(
  ctx: RunContext,
  store: ObjectStore,
  layout: Layout,
  batches: VerifyBatch[],
  counted: string[],
  selected: string[]
): Promise<ListedManifests> {
  const listed = new Map<string, ResolvedManifest[]>();
  const invalid: ChunkCheck[] = [];
  const damagedBatches = new Set<string>();

  for (const { id } of batches) {
    const perCollection = await mapLimit(counted, 4, collection =>
      listChunkManifests(store, layout, collection, id, bad => {
        damagedBatches.add(id);

        if (selected.includes(collection)) invalid.push(recordCheck(ctx, id, collection, bad));
      })
    );

    listed.set(id, perCollection.flat());
  }

  return { listed, invalid, damagedBatches };
}
