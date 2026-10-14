import readRecord from '#layout/readRecord';
import recordSchemas from '#layout/recordSchemas';
import isMsmError from '#runtime/isMsmError';
import mapLimit from '#runtime/mapLimit';
import type { BatchManifest, Layout, ObjectStore } from '#types';

/**
 * Every batch manifest under the layout, oldest cutoff first (ties by run id), so loads replay in
 * order. An invalid manifest throws, unless `onInvalid` is given: then it is reported there and
 * left out.
 */
export default async function listBatchManifests(
  store: ObjectStore,
  layout: Layout,
  onInvalid?: (key: string, message: string) => void
): Promise<{ key: string; batch: BatchManifest }[]> {
  const { keys } = await store.list(layout.batchesPrefix(), '/');
  const jsonKeys = keys.filter(k => k.endsWith('.json'));

  const read = await mapLimit(jsonKeys, 16, async key => {
    let record: { value: BatchManifest; sha256: string; text: string } | null;

    try {
      record = await readRecord(store, key, recordSchemas.batchManifest);
    } catch (err) {
      if (onInvalid === undefined || !isMsmError(err, 'record')) throw err;

      onInvalid(key, err.message);

      return null;
    }

    return record === null ? null : { key, batch: record.value };
  });

  return read
    .filter((r): r is { key: string; batch: BatchManifest } => r !== null)
    .sort(
      (a, b) =>
        a.batch.cutoff_utc.localeCompare(b.batch.cutoff_utc) ||
        a.batch.run_id.localeCompare(b.batch.run_id)
    );
}
