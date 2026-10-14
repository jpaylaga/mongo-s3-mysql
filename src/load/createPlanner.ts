import listChunkManifests from '#layout/listChunkManifests';
import readRecord from '#layout/readRecord';
import recordSchemas from '#layout/recordSchemas';
import selectChunks from '#load/selectChunks';
import isMsmError from '#runtime/isMsmError';
import mapLimit from '#runtime/mapLimit';
import type {
  Layout,
  LedgerRow,
  LoadBatchRef,
  LoadSelection,
  LoadTarget,
  ObjectStore,
  ParseCheckRecord,
  ResolvedManifest,
  SelectOptions,
} from '#types';

interface Discovered {
  manifests: ResolvedManifest[];
  checks: Map<string, ParseCheckRecord | null>;
}

/**
 * The parse-check for a chunk, or null when it is missing or damaged: both mean "unverified" to
 * selectChunks. A transient read error propagates.
 */
async function readParseCheck(
  store: ObjectStore,
  layout: Layout,
  r: ResolvedManifest
): Promise<ParseCheckRecord | null> {
  try {
    return (
      (await readRecord(store, layout.parseCheck(r.collection, r.runId), recordSchemas.parseCheck))
        ?.value ?? null
    );
  } catch (err) {
    if (isMsmError(err, 'record')) return null;

    throw err;
  }
}

/**
 * The plan of a load: per batch, the chunks of every target collection that `selectChunks` accepts
 * against the ledger as it is. The manifests and parse-checks are read from S3 once and kept, so
 * the plan taken again under the table locks only needs the ledger fresh.
 */
export default function createPlanner(
  store: ObjectStore,
  layout: Layout,
  targets: Map<string, LoadTarget>,
  batches: LoadBatchRef[],
  options: SelectOptions
): (ledgers: Map<string, LedgerRow[]>) => Promise<LoadSelection[]> {
  const discovered = new Map<string, Discovered>();

  const discover = async (collection: string, batchId: string): Promise<Discovered> => {
    const id = `${batchId}\0${collection}`;
    let found = discovered.get(id);

    if (found === undefined) {
      const manifests = await listChunkManifests(store, layout, collection, batchId);
      const checks = new Map<string, ParseCheckRecord | null>();

      await mapLimit(manifests, 16, async r => {
        checks.set(r.runId, await readParseCheck(store, layout, r));
      });

      found = { manifests, checks };
      discovered.set(id, found);
    }

    return found;
  };

  return async ledgers => {
    const selections: LoadSelection[] = [];

    for (const batch of batches) {
      const selection: LoadSelection = { batch, candidates: [], skipped: [] };

      for (const [collection, target] of targets) {
        const { manifests, checks } = await discover(collection, batch.id);

        const { candidates, skipped } = selectChunks(
          manifests,
          checks,
          ledgers.get(target.table.name) ?? [],
          target.loaded.sha256,
          options
        );

        selection.candidates.push(...candidates);
        selection.skipped.push(...skipped);
      }

      selections.push(selection);
    }

    return selections;
  };
}
