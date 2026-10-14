import formatUtc from '#runtime/formatUtc';
import type { ChunkMode, Window } from '#types';

/** Chunk run ids `{batch}-{collection}-{mode}-...`, windows as compact UTC bounds. */
export default function chunkRunId(
  batchId: string,
  collection: string,
  mode: ChunkMode,
  window: Window | null,
  tail: 'full' | 'rest' = 'full'
): string {
  const head = `${batchId}-${collection}-${mode}`;

  if (mode === 'timestamp-window' || mode === 'objectid-window') {
    if (window === null) throw new RangeError(`${mode} chunk needs a window`);

    return `${head}-${formatUtc(window.start, 'compact')}-${formatUtc(window.end, 'compact')}`;
  }

  return mode === 'manifest-only' ? `${head}-full` : `${head}-${tail}`;
}
