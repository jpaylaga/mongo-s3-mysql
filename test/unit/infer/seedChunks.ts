import { createHash } from 'node:crypto';
import chunkRunId from '#layout/chunkRunId';
import type { ChunkMode, JsonObject, Layout, ObjectStore, Window } from '#types';
import { gz, readFixture } from '../../helpers.js';

const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

export const window = (day: string): Window => {
  const start = new Date(`${day}T00:00:00Z`);

  return { start, end: new Date(start.getTime() + 86_400_000) };
};

/** The fixture lines, parsed the way infer parses them (raw `JSON.parse`, wrappers intact). */
export async function fixtureDocs(name: 'orders' | 'audit_log'): Promise<JsonObject[]> {
  const text = await readFixture(`${name}.sample.jsonl`);

  return text
    .split('\n')
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l) as JsonObject);
}

export interface SeedSpec {
  collection: string;
  batchId: string;
  lines: string[];
  mode?: ChunkMode;
  window?: Window | null;
  tail?: 'full' | 'rest';
  partSize?: number;
  cutoffUtc?: string;
}

/**
 * One chunk (manifest, parts, sidecars) in the memory store with the original exporter's key set,
 * plus `parts[]` when the lines span several parts. Infer only needs the parts and their line
 * counts.
 */
export default function seedChunks(
  store: ObjectStore & { objects: Map<string, Buffer> },
  layout: Layout
) {
  const chunk = async (spec: SeedSpec): Promise<{ runId: string; partKeys: string[] }> => {
    const mode = spec.mode ?? 'objectid-window';

    const win =
      spec.window === undefined
        ? mode === 'full-collection' || mode === 'manifest-only'
          ? null
          : window('2026-03-01')
        : spec.window;

    const runId = chunkRunId(spec.batchId, spec.collection, mode, win, spec.tail ?? 'full');
    const partSize = spec.partSize ?? Math.max(spec.lines.length, 1);
    const groups: string[][] = [];

    for (let i = 0; i < spec.lines.length; i += partSize)
      groups.push(spec.lines.slice(i, i + partSize));

    const rawPrefix = layout.rawPrefix(spec.collection, win, runId);

    const parts = groups.map((g, i) => {
      const body = gz(`${g.join('\n')}\n`);
      const key = layout.part(rawPrefix, i + 1);

      return {
        name: `part-${String(i + 1).padStart(6, '0')}.jsonl.gz`,
        key,
        body,
        bytes: body.length,
        sha256: sha256(body),
        s3_uri: layout.uri(key),
        checksum_s3_uri: `${layout.uri(key)}.sha256`,
        lines: g.length,
      };
    });

    for (const part of parts) {
      store.objects.set(part.key, part.body);
      await store.putText(`${part.key}.sha256`, `${part.sha256}  ${part.name}\n`, 'text/plain');
    }

    const first = parts[0];

    const manifest = {
      run_id: runId,
      ...layout.partition,
      collection: spec.collection,
      mode,
      filter: { mode },
      format: mode === 'manifest-only' ? 'manifest_only' : 'canonical_extended_jsonl_gzip',
      count_source: 'countDocuments',
      source_count: spec.lines.length,
      exported_count: spec.lines.length,
      counts_match: true,
      first_id: null,
      last_id: null,
      file:
        first === undefined
          ? null
          : { name: first.name, bytes: first.bytes, sha256: first.sha256, s3_uri: first.s3_uri },
      checksum_s3_uri: first === undefined ? null : first.checksum_s3_uri,
      ...(parts.length > 1 ? { parts: parts.map(({ body: _b, key: _k, ...rest }) => rest) } : {}),
      started_at: '2026-10-13T02:10:11+00:00',
      completed_at: '2026-10-13T02:10:16+00:00',
    };

    await store.putText(
      layout.chunkManifest(spec.collection, runId),
      JSON.stringify(manifest),
      'application/json'
    );

    return { runId, partKeys: parts.map(p => p.key) };
  };

  const batch = async (batchId: string, cutoffUtc: string, completedChunks = 1): Promise<void> => {
    const record = {
      run_id: batchId,
      ...layout.partition,
      cutoff_utc: cutoffUtc,
      completed_chunks: completedChunks,
      failed_chunks: 0,
      completed_at: '2026-10-13T02:11:00+00:00',
    };

    await store.putText(layout.batchManifest(batchId), JSON.stringify(record), 'application/json');
  };

  return { chunk, batch };
}
