import parseChunkRunId from '#layout/parseChunkRunId';
import readRecord from '#layout/readRecord';
import recordSchemas from '#layout/recordSchemas';
import isMsmError from '#runtime/isMsmError';
import mapLimit from '#runtime/mapLimit';
import type {
  ChunkManifest,
  ChunkRunIdParts,
  InvalidRecord,
  Layout,
  ObjectStore,
  PartRef,
  ResolvedManifest,
} from '#types';

/**
 * `parts ?? [file]`: single-part chunks look exactly like the original exporter's (no `parts[]`),
 * and then the one part holds every exported line. A uri outside this bucket or outside the chunk's
 * own raw prefix gets a null `key`: verify names it from `s3_uri`, and no reader fetches an object
 * a crafted manifest points at.
 */
function resolveParts(
  layout: Layout,
  collection: string,
  runId: string,
  id: ChunkRunIdParts,
  manifest: ChunkManifest
): PartRef[] {
  const rawPrefix = layout.rawPrefix(collection, id.window, runId);

  const keyFor = (uri: string): string | null => {
    const key = layout.keyOf(uri);

    return key !== null && key.startsWith(rawPrefix) ? key : null;
  };

  if (manifest.parts) {
    return manifest.parts.map(p => ({
      key: keyFor(p.s3_uri),
      name: p.name,
      bytes: p.bytes,
      sha256: p.sha256,
      s3_uri: p.s3_uri,
      checksum_s3_uri: p.checksum_s3_uri,
      lines: p.lines,
    }));
  }

  const file = manifest.file;

  if (file === null) return [];

  return [
    {
      key: keyFor(file.s3_uri),
      name: file.name,
      bytes: file.bytes,
      sha256: file.sha256,
      s3_uri: file.s3_uri,
      checksum_s3_uri: manifest.checksum_s3_uri,
      lines: null,
    },
  ];
}

/**
 * Chunk discovery: list the batch's manifest prefix, keep the keys whose run id parses and that sit
 * at the run id's canonical key (a copy nested deeper under the prefix is not a commit), read them.
 * A manifest that is not valid JSON or fails the schema throws, unless `onInvalid` is given: then
 * it is reported there and left out, so verify can judge every other chunk and record the bad one.
 */
export default async function listChunkManifests(
  store: ObjectStore,
  layout: Layout,
  collection: string,
  batchId: string,
  onInvalid?: (invalid: InvalidRecord) => void
): Promise<ResolvedManifest[]> {
  const prefix = layout.chunkManifestPrefix(collection, batchId);
  const { keys } = await store.list(prefix);
  const candidates: { key: string; runId: string; id: ChunkRunIdParts }[] = [];

  for (const key of keys) {
    const name = key.slice(key.lastIndexOf('/') + 1);

    if (!name.startsWith('run_id=') || !name.endsWith('.json')) continue;

    const runId = name.slice('run_id='.length, -'.json'.length);

    if (key !== layout.chunkManifest(collection, runId)) continue;

    const id = parseChunkRunId(runId, batchId, collection);

    if (id !== null) candidates.push({ key, runId, id });
  }

  const resolved = await mapLimit(candidates, 16, async ({ key, runId, id }) => {
    let record: { value: ChunkManifest; sha256: string; text: string } | null;

    try {
      record = await readRecord(store, key, recordSchemas.chunkManifest);
    } catch (err) {
      if (onInvalid === undefined || !isMsmError(err, 'record')) throw err;

      onInvalid({ key, runId, id, message: err.message });

      return null;
    }

    if (record === null) return null;

    return {
      key,
      sha256: record.sha256,
      text: record.text,
      manifest: record.value,
      batchId,
      collection,
      runId,
      id,
      parts: resolveParts(layout, collection, runId, id, record.value),
    } satisfies ResolvedManifest;
  });

  return resolved
    .filter((r): r is ResolvedManifest => r !== null)
    .sort((a, b) => a.runId.localeCompare(b.runId));
}
