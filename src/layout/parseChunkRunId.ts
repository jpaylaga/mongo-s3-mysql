import type { ChunkRunIdParts } from '#types';

const windowed = /^(timestamp-window|objectid-window)-(\d{8}T\d{6}Z)-(\d{8}T\d{6}Z)$/;
const full = /^full-collection-(full|rest)$/;
const manifestOnly = /^manifest-only-full$/;

const compactToDate = (s: string): Date | null => {
  const date = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const time = `${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`;
  const d = new Date(`${date}T${time}Z`);

  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Inverse of `chunkRunId` for one batch and collection. The fixed `{b}-{c}-` prefix plus the strict
 * tail grammar keeps prefix listings unambiguous when batch ids or collection names contain
 * hyphens.
 */
export default function parseChunkRunId(
  runId: string,
  batchId: string,
  collection: string
): ChunkRunIdParts | null {
  const head = `${batchId}-${collection}-`;

  if (!runId.startsWith(head)) return null;

  const tail = runId.slice(head.length);
  const w = windowed.exec(tail);

  if (w) {
    const start = compactToDate(w[2] as string);
    const end = compactToDate(w[3] as string);

    if (start === null || end === null) return null;

    return {
      mode: w[1] as 'timestamp-window' | 'objectid-window',
      window: { start, end },
      tail: 'window',
    };
  }

  const f = full.exec(tail);

  if (f) return { mode: 'full-collection', window: null, tail: f[1] as 'full' | 'rest' };

  if (manifestOnly.test(tail)) return { mode: 'manifest-only', window: null, tail: 'full' };

  return null;
}
