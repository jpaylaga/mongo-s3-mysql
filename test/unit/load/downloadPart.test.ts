import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import downloadPart from '../../../src/load/downloadPart.js';
import type { PartRef } from '../../../src/types.js';
import { gz, memoryContext, tmpDir } from '../../helpers.js';
import { sha256 } from '../verify/seedArchive.js';

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

function setup() {
  const { store, layout } = memoryContext({ command: 'load' });
  const body = gz('{"_id":{"$oid":"65f1c0a1b2c3d4e5f6a7b8c9"}}\n{"_id":{"$oid":"65f1c0a1b2c3d4e5f6a7b8ca"}}\n');
  const key = `${layout.rawPrefix('audit_log', null, 'r')}part-000001.jsonl.gz`;
  store.objects.set(key, body);
  const part: PartRef = { key, name: 'part-000001.jsonl.gz', bytes: body.length, sha256: sha256(body), s3_uri: layout.uri(key), checksum_s3_uri: null, lines: 2 };
  return { store, layout, body, key, part };
}

describe('downloadPart', () => {
  it('streams the object to the path, creating the directory, when bytes and sha256 match the manifest', async () => {
    const { store, layout, body, part } = setup();
    const path = join(await tmpDir(), 'load', 'r', part.name);
    await downloadPart(store, part, path, 0);
    expect(Buffer.compare(await readFile(path), body)).toBe(0);
  });

  it('reads the resolved key, which listChunkManifests derived from the s3_uri, and never a path of its own', async () => {
    const { store, layout, part, key } = setup();
    const path = join(await tmpDir(), 'by-position.jsonl.gz');
    expect(layout.keyOf(part.s3_uri)).toBe(key);
    await downloadPart(store, part, path, 0);
    expect(await exists(path)).toBe(true);
    await expect(downloadPart(store, { ...part, key: 'not/the/real/key' }, join(await tmpDir(), 'x'), 0)).rejects.toMatchObject({ msmCode: 'record' });
  });

  it('a missing object is a record error and leaves no file behind', async () => {
    const { store, layout, part } = setup();
    const path = join(await tmpDir(), part.name);
    const missing = { ...part, key: 'raw/missing', s3_uri: layout.uri('raw/missing') };
    await expect(downloadPart(store, missing, path, 0)).rejects.toMatchObject({ msmCode: 'record', message: 'part-000001.jsonl.gz: object raw/missing is missing' });
    expect(await exists(path)).toBe(false);
  });

  it('a byte count other than the manifest says is a sha256 error and the partial file is removed', async () => {
    const { store, layout, part } = setup();
    const path = join(await tmpDir(), part.name);
    await expect(downloadPart(store, { ...part, bytes: part.bytes + 1 }, path, 0)).rejects.toMatchObject({
      msmCode: 'sha256', message: `part-000001.jsonl.gz: downloaded ${part.bytes} bytes, manifest says ${part.bytes + 1}`,
    });
    expect(await exists(path)).toBe(false);
  });

  it('a digest other than the manifest says is a sha256 error even when the size matches', async () => {
    const { store, layout, part } = setup();
    const path = join(await tmpDir(), part.name);
    const wrong = 'f'.repeat(64);
    await expect(downloadPart(store, { ...part, sha256: wrong }, path, 0)).rejects.toMatchObject({
      msmCode: 'sha256', message: `part-000001.jsonl.gz: sha256 ${part.sha256.slice(0, 12)} differs from the manifest's ${wrong.slice(0, 12)}`,
    });
    expect(await exists(path)).toBe(false);
  });

  it('refuses to start when the volume lacks the reservation plus the free-space floor', async () => {
    const { store, layout, part } = setup();
    const path = join(await tmpDir(), part.name);
    await expect(downloadPart(store, part, path, Number.MAX_SAFE_INTEGER / 1024 / 1024)).rejects.toMatchObject({ msmCode: 'disk' });
    expect(await exists(path)).toBe(false);
  });

it('never asks S3 for a part whose s3_uri is outside the chunk\'s raw prefix (key null)', async () => {
    const { store, part } = setup();
    let reads = 0;
    const getStream = store.getStream.bind(store);
    store.getStream = async (key) => { reads += 1; return getStream(key); };
    const path = join(await tmpDir(), part.name);
    await expect(downloadPart(store, { ...part, key: null, s3_uri: 's3://other-bucket/x/part-000001.jsonl.gz' }, path, 0))
      .rejects.toMatchObject({ msmCode: 'record', message: "part-000001.jsonl.gz: s3_uri s3://other-bucket/x/part-000001.jsonl.gz is outside the chunk's raw prefix" });
    expect(reads).toBe(0);
    expect(await exists(path)).toBe(false);
  });

  it('stops the stream as soon as the object passes the manifest\'s size, so a larger object never overruns the reservation', async () => {
    const { store, part, key, body } = setup();
    store.objects.set(key, Buffer.concat([body, Buffer.alloc(4096)]));
    const path = join(await tmpDir(), part.name);
    await expect(downloadPart(store, part, path, 0)).rejects.toMatchObject({ msmCode: 'sha256', message: `part-000001.jsonl.gz: more than the ${part.bytes} bytes the manifest says` });
    expect(await exists(path)).toBe(false);
  });

  it('writes the file and its directory owner-only, since the temp directory may be a shared volume', async () => {
    const { store, part } = setup();
    const dir = join(await tmpDir(), 'load', 'r');
    const path = join(dir, part.name);
    await downloadPart(store, part, path, 0);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});
