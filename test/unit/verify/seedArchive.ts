import { createHash } from 'node:crypto';
import chunkRunId from '#layout/chunkRunId';
import formatUtc from '#runtime/formatUtc';
import type { ChunkMode, Layout, ObjectStore, Window } from '#types';
import { gz } from '../../helpers.js';

export const sha256 = (body: Buffer | string): string =>
  createHash('sha256').update(body).digest('hex');

/** A spaced canonical line like the original exporter wrote, with a deterministic ObjectId. */
export const docLine = (i: number, extra = ''): string =>
  '{ "_id" : { "$oid" : ' +
  `"${(0x69a4d301 + i).toString(16)}5a5a5a${String(i).padStart(10, '0')}" }, "n" : ` +
  `{ "$numberInt" : "${i}" }${extra} }`;

export const lines = (count: number, from = 1): string[] =>
  Array.from({ length: count }, (_, i) => docLine(from + i));

export interface ChunkSpec {
  collection: string;
  batchId: string;
  mode?: ChunkMode;
  window?: Window | null;
  tail?: 'full' | 'rest';
  lines?: string[];
  partSize?: number;
  bom?: number;
  manifest?: Record<string, unknown>;
  /**
   * The object bodies to store instead of the gzipped lines (tamper cases); the manifest still
   * describes the real ones.
   */
  objects?: (Buffer | null)[];
}

export interface SeededChunk {
  runId: string;
  key: string;
  manifest: Record<string, unknown>;
  partKeys: string[];
  sidecarKeys: string[];
}

export const window = (day: string): Window => ({
  start: new Date(`${day}T00:00:00Z`),
  end: new Date(
    `${new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`
  ),
});

/**
 * Writes chunks and batch manifests into a memory store with exactly the original exporter's key
 * sets (plus `parts[]` when a chunk has more than one part), so verify is tested against the real
 * layout.
 */
export default function seedArchive(store: ObjectStore, layout: Layout) {
  const chunk = async (spec: ChunkSpec): Promise<SeededChunk> => {
    const mode = spec.mode ?? 'timestamp-window';

    const win =
      spec.window === undefined
        ? mode === 'timestamp-window' || mode === 'objectid-window'
          ? window('2026-03-02')
          : null
        : spec.window;

    const runId = chunkRunId(spec.batchId, spec.collection, mode, win, spec.tail ?? 'full');
    const text = spec.lines ?? [];
    const partSize = spec.partSize ?? Math.max(text.length, 1);
    const groups: string[][] = [];

    for (let i = 0; i < text.length; i += partSize) groups.push(text.slice(i, i + partSize));

    const rawPrefix = layout.rawPrefix(spec.collection, win, runId);

    const parts = groups.map((g, i) => {
      const body = gz(`${i === spec.bom ? '﻿' : ''}${g.join('\n')}\n`);
      const name = `part-${String(i + 1).padStart(6, '0')}.jsonl.gz`;
      const key = layout.part(rawPrefix, i + 1);

      return {
        name,
        key,
        body,
        bytes: body.length,
        sha256: sha256(body),
        s3_uri: layout.uri(key),
        checksum_s3_uri: `${layout.uri(key)}.sha256`,
        lines: g.length,
      };
    });

    const first = parts[0];

    const filter =
      mode === 'manifest-only'
        ? { mode, filter: 'no raw export; manifest and validation only' }
        : mode === 'full-collection'
          ? {
              mode,
              filter: spec.tail === 'rest' ? 'documents outside the windows' : 'all documents',
            }
          : {
              mode,
              field: mode === 'objectid-window' ? '_id' : 'created_at',
              start_utc: formatUtc((win as Window).start, 'offset'),
              end_utc: formatUtc((win as Window).end, 'offset'),
              boundary: '[start,end)',
            };

    const idOf = (line: string | undefined): string | null => {
      try {
        return line === undefined
          ? null
          : ((JSON.parse(line) as { _id?: { $oid?: string } })._id?.$oid ?? null);
      } catch {
        return null; // tamper cases seed lines that are not documents
      }
    };

    const manifest: Record<string, unknown> = {
      run_id: runId,
      ...layout.partition,
      collection: spec.collection,
      mode,
      filter,
      format: mode === 'manifest-only' ? 'manifest_only' : 'canonical_extended_jsonl_gzip',
      count_source: 'countDocuments',
      source_count: text.length,
      exported_count: text.length,
      counts_match: true,
      first_id: idOf(text[0]),
      last_id: idOf(text[text.length - 1]),
      file:
        first === undefined
          ? null
          : { name: first.name, bytes: first.bytes, sha256: first.sha256, s3_uri: first.s3_uri },
      checksum_s3_uri: first === undefined ? null : first.checksum_s3_uri,
      ...(parts.length > 1
        ? {
            parts: parts.map(({ name, bytes, sha256: s, s3_uri, checksum_s3_uri, lines: l }) => ({
              name,
              bytes,
              sha256: s,
              s3_uri,
              checksum_s3_uri,
              lines: l,
            })),
          }
        : {}),
      started_at: '2026-10-13T02:10:11+00:00',
      completed_at: '2026-10-13T02:10:16+00:00',
      area: 'example-area',
      ...(spec.manifest ?? {}),
    };

    const partKeys: string[] = [];
    const sidecarKeys: string[] = [];

    for (const [i, part] of parts.entries()) {
      const body = spec.objects === undefined ? part.body : spec.objects[i];

      // Parts go straight into the memory store's map: putFile wants a path on disk, and a tamper
      // case needs to store bytes the manifest does not describe.
      if (body !== null && body !== undefined)
        (store as ObjectStore & { objects: Map<string, Buffer> }).objects.set(part.key, body);

      partKeys.push(part.key);

      const sidecarKey = `${part.key}.sha256`;

      await store.putText(sidecarKey, `${part.sha256}  ${part.name}\n`, 'text/plain');
      sidecarKeys.push(sidecarKey);
    }

    const key = layout.chunkManifest(spec.collection, runId);

    await store.putText(key, JSON.stringify(manifest), 'application/json');

    return { runId, key, manifest, partKeys, sidecarKeys };
  };

  const batch = async (
    batchId: string,
    completedChunks: number,
    patch: Record<string, unknown> = {}
  ): Promise<void> => {
    const record = {
      run_id: batchId,
      ...layout.partition,
      cutoff_utc: '2026-10-13T01:00:00Z',
      covered_areas: ['example-area'],
      completed_chunks: completedChunks,
      failed_chunks: 0,
      completed_at: '2026-10-13T02:11:00+00:00',
      notes: 'written by the original exporter',
      ...patch,
    };

    await store.putText(layout.batchManifest(batchId), JSON.stringify(record), 'application/json');
  };

  return { chunk, batch };
}
