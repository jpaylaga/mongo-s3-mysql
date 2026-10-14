import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import listChunkManifests from '#layout/listChunkManifests';
import toolVersion from '#runtime/toolVersion';
import type { ResolvedManifest } from '#types';
import verifyChunk from '#verify/verifyChunk';
import { gz, memoryContext } from '../../helpers.js';
import seedArchive, { docLine, lines, sha256, window } from './seedArchive.js';
import type { ChunkSpec } from './seedArchive.js';

const B = 'app-archive-full-20261013T020304Z';

async function seeded(spec: Partial<ChunkSpec> = {}) {
  const now = () => new Date('2026-10-13T03:00:00Z');
  const { ctx, store, layout } = memoryContext({ command: 'verify', now });
  const seed = seedArchive(store, layout);
  const collection = spec.collection ?? 'audit_log';
  const chunk = await seed.chunk({ collection, batchId: B, lines: lines(12), ...spec });

  const resolved = (await listChunkManifests(store, layout, collection, B)).find(
    r => r.runId === chunk.runId
  ) as ResolvedManifest;

  return {
    ctx,
    store,
    layout,
    chunk,
    resolved,
    run: () => verifyChunk(ctx, store, layout, resolved),
  };
}

describe('verifyChunk', () => {
  it('passes an intact single-part chunk and fills both validation records', async () => {
    const { run, resolved } = await seeded();
    const check = await run();

    expect(check.ok).toBe(true);
    expect(check.errors).toEqual([]);
    expect(check.lines).toBe(12);
    expect(check.runId).toBe(resolved.runId);

    expect(check.counts).toEqual({
      run_id: resolved.runId,
      collection: 'audit_log',
      mode: 'timestamp-window',
      count_source: 'countDocuments',
      source_count: 12,
      exported_count: 12,
      matches: true,
      verified_lines: 12,
    });

    expect(check.parseCheck).toEqual({
      run_id: resolved.runId,
      collection: 'audit_log',
      mode: 'timestamp-window',
      gzip_test: true,
      first_line_parseable: true,
      first_line_has_id: true,
      manifest_only: false,
      ok: true,
      lines: 12,
      parse_errors: 0,
      missing_ids: 0,
      bytes_ok: true,
      sha256_ok: true,
      sidecar_ok: true,
      manifest_sha256: resolved.sha256,
      verified_at: '2026-10-13T03:00:00+00:00',
      errors: [],
      tool: toolVersion,
    });
  });

  it('reads every part of a multi-part chunk, tolerating a BOM on a part', async () => {
    const { run, resolved } = await seeded({ lines: lines(25), partSize: 10, bom: 1 });

    expect(resolved.parts).toHaveLength(3);

    const check = await run();

    expect(check.ok).toBe(true);
    expect(check.lines).toBe(25);
    expect(check.counts?.verified_lines).toBe(25);
  });

  it('keeps source_count_after and judges counts_match against it', async () => {
    const { run } = await seeded({ manifest: { source_count_after: 12 } });

    expect((await run()).counts?.source_count_after).toBe(12);

    const drift = await seeded({ manifest: { source_count_after: 13 } });
    const check = await drift.run();

    expect(check.ok).toBe(false);

    expect(check.errors).toEqual([
      expect.stringMatching(/counts_match true but .*source_count_after 13/),
    ]);
  });

  it('reports a sha256 mismatch when valid gzip bytes differ from the manifest', async () => {
    const { ctx, store, layout, resolved } = await seeded();
    const body = gz(`${lines(12).join('\n')}\n`);

    const tampered = {
      ...resolved,
      parts: resolved.parts.map(p => ({ ...p, sha256: sha256('not this body') })),
    };

    await store.putText(
      `${tampered.parts[0]?.key}.sha256`,
      `${sha256('not this body')}  part-000001.jsonl.gz\n`,
      'text/plain'
    );

    expect(body.length).toBe(tampered.parts[0]?.bytes);

    const check = await verifyChunk(ctx, store, layout, tampered);

    expect(check.ok).toBe(false);
    expect(check.parseCheck.sha256_ok).toBe(false);
    expect(check.parseCheck.bytes_ok).toBe(true);
    expect(check.parseCheck.gzip_test).toBe(true);

    expect(check.errors).toEqual([
      expect.stringMatching(
        /part-000001\.jsonl\.gz: sha256 [0-9a-f]{12} differs from the manifest's [0-9a-f]{12}/
      ),
    ]);
  });

  it('fails a flipped byte in the part', async () => {
    const body = gz(`${lines(12).join('\n')}\n`);
    const flipped = Buffer.from(body);

    flipped[flipped.length - 20] = (flipped[flipped.length - 20] as number) ^ 0xff;

    const { run } = await seeded({ objects: [flipped] });
    const check = await run();

    expect(check.ok).toBe(false);
    expect(check.parseCheck.bytes_ok).toBe(true);
    expect(check.parseCheck.sha256_ok === false || check.parseCheck.gzip_test === false).toBe(true);
    expect(check.errors.length).toBeGreaterThan(0);
  });

  it('fails an object that is not gzip at all', async () => {
    const real = gz(`${lines(12).join('\n')}\n`);
    const { run } = await seeded({ objects: [randomBytes(real.length)] });
    const check = await run();

    expect(check.ok).toBe(false);
    expect(check.parseCheck.gzip_test).toBe(false);
    expect(check.parseCheck.sha256_ok).toBe(false);
    expect(check.errors).toContainEqual(expect.stringMatching(/gunzip failed/));
  });

  it('reports a line count that drifted from exported_count', async () => {
    const { run } = await seeded({
      lines: lines(12),
      manifest: { exported_count: 11, source_count: 11 },
    });

    const check = await run();

    expect(check.ok).toBe(false);
    expect(check.lines).toBe(12);
    expect(check.errors).toEqual(['12 lines, exported_count 11']);
  });

  it('reports a per-part line count that drifted in parts[]', async () => {
    const { ctx, store, layout, resolved } = await seeded({ lines: lines(20), partSize: 10 });

    const tampered = {
      ...resolved,
      parts: resolved.parts.map((p, i) => (i === 1 ? { ...p, lines: 9 } : p)),
    };

    const check = await verifyChunk(ctx, store, layout, tampered);

    expect(check.errors).toEqual(['part-000002.jsonl.gz: 10 lines, manifest says 9']);
  });

  it('reports a sidecar whose body differs and a sidecar that is missing', async () => {
    const bad = await seeded();

    await bad.store.putText(
      bad.chunk.sidecarKeys[0] as string,
      `${'0'.repeat(64)}  part-000001.jsonl.gz\n`,
      'text/plain'
    );

    let check = await bad.run();

    expect(check.parseCheck.sidecar_ok).toBe(false);

    expect(check.errors).toEqual([
      'part-000001.jsonl.gz: sidecar body differs from "<sha256>  <name>"',
    ]);

    const gone = await seeded();

    gone.store.objects.delete(gone.chunk.sidecarKeys[0] as string);
    check = await gone.run();
    expect(check.errors).toEqual(['part-000001.jsonl.gz: sidecar missing']);
  });

  it('reports an object whose size differs from the manifest', async () => {
    const { ctx, store, layout, resolved } = await seeded();

    const tampered = {
      ...resolved,
      parts: resolved.parts.map(p => ({ ...p, bytes: p.bytes + 5 })),
    };

    const check = await verifyChunk(ctx, store, layout, tampered);

    expect(check.parseCheck.bytes_ok).toBe(false);
    expect(check.errors[0]).toMatch(/object is \d+ bytes, manifest says \d+/);
  });

  it('reports a missing object', async () => {
    const { run } = await seeded({ objects: [null] });
    const check = await run();

    expect(check.ok).toBe(false);
    expect(check.errors).toEqual(['part-000001.jsonl.gz: object missing']);
    expect(check.parseCheck.bytes_ok).toBe(false);
  });

  it('counts lines without _id and lines that are not JSON', async () => {
    const text = ['{ "no_id" : true }', ...lines(3), 'not json', '{ "_id" : 1 }'];
    const { run } = await seeded({ lines: text });
    const check = await run();

    expect(check.ok).toBe(false);

    expect(check.parseCheck).toMatchObject({
      first_line_parseable: true,
      first_line_has_id: false,
      missing_ids: 1,
      parse_errors: 1,
      lines: 6,
    });

    expect(check.errors).toEqual([
      'part-000001.jsonl.gz: line 1 has no _id',
      'part-000001.jsonl.gz: line 5 is not JSON',
    ]);
  });

  it('caps the listed parse errors', async () => {
    const { run } = await seeded({ lines: Array.from({ length: 9 }, () => 'nope') });
    const check = await run();

    expect(check.parseCheck.parse_errors).toBe(9);
    expect(check.errors.filter(e => e.includes('is not JSON'))).toHaveLength(5);
    expect(check.errors).toContain('part-000001.jsonl.gz: 4 more lines are not JSON');
  });

  it('reports invalid UTF-8 as a parse error, not a throw; integrity from a re-read', async () => {
    const body = gzipSync(
      Buffer.concat([
        Buffer.from(`${docLine(1)}\n{ "_id" : "`),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('" }\n'),
      ])
    );

    const { run } = await seeded({ objects: [body] });
    const check = await run();

    expect(check.ok).toBe(false);

    // The object differs from the manifest here (it is the tampered body), so the size and sha256
    // lines are true; no line-count error, and gunzip has no verdict since decoding stopped.
    expect(check.errors).toEqual([
      expect.stringMatching(/^part-000001\.jsonl\.gz: object is \d+ bytes, manifest says \d+$/),
      'part-000001.jsonl.gz: invalid UTF-8',
      expect.stringMatching(/^part-000001\.jsonl\.gz: read \d+ bytes, manifest says \d+$/),
      expect.stringMatching(/sha256 .* differs/),
    ]);

    expect(check.parseCheck.gzip_test).toBeNull();

    // With a manifest and sidecar that describe the bad object exactly, the text is the only error.
    const intact = await seeded({ objects: [body] });

    await intact.store.putText(
      intact.chunk.sidecarKeys[0] as string,
      `${sha256(body)}  part-000001.jsonl.gz\n`,
      'text/plain'
    );

    const tampered = {
      ...intact.resolved,
      parts: intact.resolved.parts.map(p => ({ ...p, bytes: body.length, sha256: sha256(body) })),
    };

    const exact = await verifyChunk(intact.ctx, intact.store, intact.layout, tampered);

    expect(exact.errors).toEqual(['part-000001.jsonl.gz: invalid UTF-8']);
    expect(exact.parseCheck).toMatchObject({ bytes_ok: true, sha256_ok: true, gzip_test: null });
  });

  it('a gunzip failure mid-part keeps bytes_ok and sha256_ok from the whole object', async () => {
    const real = gz(`${lines(12).join('\n')}\n`);
    const damaged = Buffer.from(real);

    for (let i = 20; i < 40 && i < damaged.length - 10; i += 1)
      damaged[i] = (damaged[i] as number) ^ 0xff;

    const { run } = await seeded({ objects: [damaged] });
    const check = await run();

    expect(check.parseCheck.gzip_test).toBe(false);
    expect(check.parseCheck.bytes_ok).toBe(true);
    expect(check.parseCheck.sha256_ok).toBe(false);
    expect(check.errors.some(e => /lines, exported_count/.test(e))).toBe(false);
  });

  it('refuses a part whose name is not the last segment of its object key', async () => {
    const { ctx, store, layout, resolved } = await seeded();

    const renamed = {
      ...resolved,
      parts: resolved.parts.map(p => ({ ...p, name: '../../victim.gz' })),
    };

    const check = await verifyChunk(ctx, store, layout, renamed);

    expect(check.errors).toContainEqual(
      "../../victim.gz: name differs from the object key's part-000001.jsonl.gz"
    );
  });

  it('checks the partition fields and the run id against the manifest', async () => {
    const { run } = await seeded({
      manifest: {
        region: 'eu-west-1',
        mode: 'objectid-window',
        filter: { mode: 'objectid-window' },
      },
    });

    const check = await run();

    expect(check.errors).toEqual(
      expect.arrayContaining([
        'partition region is "eu-west-1", config says "us-east-1"',
        "mode objectid-window differs from the run id's timestamp-window",
      ])
    );
  });

  it('flags counts_match that disagrees with the counts', async () => {
    const { run } = await seeded({ manifest: { source_count: 13 } });

    expect((await run()).errors).toEqual([
      'counts_match true but source_count 13, exported_count 12',
    ]);

    const flagged = await seeded({ manifest: { source_count: 13, counts_match: false } });

    expect((await flagged.run()).ok).toBe(true);
  });

  it('passes a manifest-only chunk without any read; rejects one with content fields', async () => {
    const { run, store } = await seeded({
      collection: 'sessions',
      mode: 'manifest-only',
      lines: [],
    });

    const reads = store.getStream;

    store.getStream = async () => {
      throw new Error('must not read');
    };

    const check = await run();

    store.getStream = reads;
    expect(check.ok).toBe(true);
    expect(check.lines).toBe(0);

    expect(check.parseCheck).toMatchObject({
      manifest_only: true,
      gzip_test: null,
      first_line_parseable: null,
      first_line_has_id: null,
      bytes_ok: null,
      sha256_ok: null,
      sidecar_ok: null,
      ok: true,
    });

    const bad = await seeded({
      collection: 'sessions',
      mode: 'manifest-only',
      lines: [],
      manifest: {
        format: 'canonical_extended_jsonl_gzip',
        first_id: 'x',
        checksum_s3_uri: 's3://example-archive-bucket/x',
      },
    });

    expect((await bad.run()).errors).toEqual([
      'manifest-only chunk has format canonical_extended_jsonl_gzip',
      'manifest-only chunk has ids',
      'manifest-only chunk has a checksum_s3_uri',
    ]);
  });

  it('passes an empty window (file null) and flags exported_count without parts', async () => {
    const empty = await seeded({ lines: [] });

    expect((await empty.run()).ok).toBe(true);

    const bad = await seeded({ lines: [], manifest: { exported_count: 3, source_count: 3 } });

    expect((await bad.run()).errors).toEqual(['exported_count 3 with no parts']);
  });

  it('rejects part uris outside the bucket or the raw prefix without reading them', async () => {
    const { ctx, store, layout, resolved } = await seeded();

    const outside = {
      ...resolved,
      parts: resolved.parts.map(p => ({
        ...p,
        key: null,
        s3_uri: p.s3_uri.replace('example-archive-bucket', 'other'),
      })),
    };

    let check = await verifyChunk(ctx, store, layout, outside);

    expect(check.errors).toEqual([
      expect.stringMatching(
        /part-000001\.jsonl\.gz: s3:\/\/other\/.* is outside s3:\/\/example-archive-bucket\//
      ),
    ]);

    const otherPrefix = layout.rawPrefix('orders', window('2026-03-02'), 'x');

    const elsewhere = {
      ...resolved,
      parts: resolved.parts.map(p => ({
        ...p,
        key: null,
        s3_uri: layout.uri(`${otherPrefix}part-000001.jsonl.gz`),
      })),
    };

    check = await verifyChunk(ctx, store, layout, elsewhere);
    expect(check.errors).toEqual([expect.stringMatching(/is outside the chunk's raw prefix$/)]);
  });

  it('rethrows operational failures so the chunk attempt can retry', async () => {
    const { run, store } = await seeded();

    store.getStream = async () => {
      throw Object.assign(new Error('SlowDown'), {
        name: 'SlowDown',
        $metadata: { httpStatusCode: 503 },
      });
    };

    await expect(run()).rejects.toThrow('SlowDown');
  });

  it('stops with an interrupted error when the signal is aborted', async () => {
    const controller = new AbortController();
    const { ctx, store, layout } = memoryContext({ command: 'verify', signal: controller.signal });
    const seed = seedArchive(store, layout);
    const chunk = await seed.chunk({ collection: 'audit_log', batchId: B, lines: lines(3) });
    const [resolved] = await listChunkManifests(store, layout, 'audit_log', B);

    controller.abort('SIGINT');

    await expect(
      verifyChunk(ctx, store, layout, resolved as ResolvedManifest)
    ).rejects.toMatchObject({ msmCode: 'interrupted', message: `${chunk.runId}: interrupted` });
  });
});
