import { describe, expect, it } from 'vitest';
import listChunkManifests from '../../../src/layout/listChunkManifests.js';
import { memoryContext, realShape } from '../../helpers.js';

const B = 'app-archive-full-20261013T020304Z';

async function seeded() {
  const { store, layout } = memoryContext();
  const put = async (collection: string, fixture: string, patch: Record<string, unknown> = {}) => {
    const m = { ...(await realShape(fixture) as Record<string, unknown>), ...patch };
    await store.putText(layout.chunkManifest(collection, m.run_id as string), JSON.stringify(m), 'application/json');
    return m;
  };
  return { store, layout, put };
}

describe('listChunkManifests', () => {
  it('lists only the manifests whose run id belongs to the batch and collection', async () => {
    const { store, layout, put } = await seeded();
    await put('audit_log', 'chunk-timestamp-window.json');
    await put('audit_log', 'chunk-timestamp-window.json', { run_id: `${B}-audit_log-full-collection-rest` });
    await put('audit_log', 'chunk-timestamp-window.json', { run_id: `${B}-2-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z` });
    await put('audit_log', 'chunk-timestamp-window.json', { run_id: `${B}-audit_log-timestamp-window-bad` });
    await put('orders', 'chunk-objectid-window.json');
    const resolved = await listChunkManifests(store, layout, 'audit_log', B);
    expect(resolved.map((r) => r.runId)).toEqual([`${B}-audit_log-full-collection-rest`, `${B}-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z`]);
    expect(resolved[1]?.id).toMatchObject({ mode: 'timestamp-window', tail: 'window' });
    expect(resolved[1]?.batchId).toBe(B);
    expect(resolved[1]?.collection).toBe('audit_log');
    expect(resolved[1]?.key).toBe(layout.chunkManifest('audit_log', resolved[1]?.runId as string));
    expect(await listChunkManifests(store, layout, 'audit_log', 'other-batch')).toEqual([]);
  });

  it('resolves a single-part manifest from file and checksum_s3_uri with lines null', async () => {
    const { store, layout, put } = await seeded();
    const m = await put('audit_log', 'chunk-timestamp-window.json');
    const [r] = await listChunkManifests(store, layout, 'audit_log', B);
    const file = m.file as Record<string, string>;
    expect(r?.parts).toEqual([{
      key: layout.keyOf(file.s3_uri as string), name: 'part-000001.jsonl.gz', bytes: 1234, sha256: file.sha256, s3_uri: file.s3_uri,
      checksum_s3_uri: m.checksum_s3_uri, lines: null,
    }]);
    expect(r?.parts[0]?.key).toBe(`${layout.rawPrefix('audit_log', { start: new Date('2026-03-02T00:00:00Z'), end: new Date('2026-03-03T00:00:00Z') }, r?.runId as string)}part-000001.jsonl.gz`);
  });

  it('resolves parts[] when present and gives a part outside the bucket or the raw prefix no key', async () => {
    const { store, layout, put } = await seeded();
    const base = await realShape('chunk-timestamp-window.json') as Record<string, unknown>;
    const file = base.file as Record<string, unknown>;
    await put('audit_log', 'chunk-timestamp-window.json', {
      parts: [{ ...file, checksum_s3_uri: `${file.s3_uri}.sha256`, lines: 10 }, { ...file, name: 'part-000002.jsonl.gz', s3_uri: 's3://other-bucket/x/part-000002.jsonl.gz', checksum_s3_uri: null, lines: 2 }],
    });
    const [r] = await listChunkManifests(store, layout, 'audit_log', B);
    expect(r?.parts.map((p) => p.lines)).toEqual([10, 2]);
    expect(r?.parts[1]?.key).toBeNull();
    expect(r?.parts[1]?.s3_uri).toBe('s3://other-bucket/x/part-000002.jsonl.gz');
    // Inside the bucket but under another chunk's prefix: a crafted manifest must not point a reader at that object either.
    const elsewhere = layout.uri(`${layout.rawPrefix('orders', null, 'x')}part-000001.jsonl.gz`);
    await put('audit_log', 'chunk-timestamp-window.json', { file: { ...file, s3_uri: elsewhere } });
    const [moved] = await listChunkManifests(store, layout, 'audit_log', B);
    expect(moved?.parts[0]).toMatchObject({ key: null, s3_uri: elsewhere });
  });

  it('accepts a manifest only at its canonical key: a copy nested deeper under the prefix is not a commit', async () => {
    const { store, layout, put } = await seeded();
    const m = await put('audit_log', 'chunk-timestamp-window.json');
    const runId = m.run_id as string;
    const canonical = layout.chunkManifest('audit_log', runId);
    await store.putText(`${canonical.slice(0, -'.json'.length)}-copy/run_id=${runId}.json`, (await store.getText(canonical)) as string, 'application/json');
    expect((await listChunkManifests(store, layout, 'audit_log', B)).map((m) => m.key)).toEqual([canonical]);
  });

  it('gives manifest-only chunks no parts and keeps partition fields for verify to check', async () => {
    const { store, layout, put } = await seeded();
    await put('sessions', 'chunk-manifest-only.json');
    await put('coupons', 'chunk-full-collection.json', { region: 'eu-west-1' });
    const [only] = await listChunkManifests(store, layout, 'sessions', B);
    expect(only?.parts).toEqual([]);
    expect(only?.id.mode).toBe('manifest-only');
    const [mismatch] = await listChunkManifests(store, layout, 'coupons', B);
    expect((mismatch?.manifest as Record<string, unknown>).region).toBe('eu-west-1');
    expect(layout.partition.region).toBe('us-east-1');
  });

  it('propagates an invalid manifest as a record error', async () => {
    const { store, layout } = await seeded();
    await store.putText(layout.chunkManifest('audit_log', `${B}-audit_log-full-collection-full`), '{"run_id": 1}', 'application/json');
    await expect(listChunkManifests(store, layout, 'audit_log', B)).rejects.toMatchObject({ msmCode: 'record' });
  });
});
