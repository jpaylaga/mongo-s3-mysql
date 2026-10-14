import { createHash } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import uploadPart from '#export/uploadPart';
import idBrackets from '#mongo/idBrackets';
import type { ClosedPart } from '#types';
import { gz, memoryContext, tmpDir } from '../../helpers.js';
import { keysetPlan } from './fakeMongo.js';

async function closedPart(lines: string[], over: Partial<ClosedPart> = {}): Promise<ClosedPart> {
  const dir = await tmpDir();
  const body = gz(lines.map(l => `${l}\n`).join(''));
  const path = join(dir, 'part-000001.jsonl.gz');

  await writeFile(path, body);

  return {
    n: 1,
    path,
    name: 'part-000001.jsonl.gz',
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    lines: lines.length,
    ...over,
  };
}

describe('uploadPart', () => {
  it('gunzip-tests, uploads with sha256 metadata, writes a sidecar, removes the file', async () => {
    const { store, layout } = memoryContext();

    const plan = keysetPlan(
      'b',
      'orders',
      idBrackets,
      layout.rawPrefix('orders', null, 'b-orders-full-collection-full')
    );

    const part = await closedPart(['{"_id":1}', '{"_id":2}']);
    const ref = await uploadPart(store, layout, plan, part, new AbortController().signal);
    const key = layout.part(plan.rawPrefix, 1);

    expect(ref).toEqual({
      key,
      name: 'part-000001.jsonl.gz',
      bytes: part.bytes,
      sha256: part.sha256,
      s3_uri: layout.uri(key),
      checksum_s3_uri: layout.uri(`${key}.sha256`),
      lines: 2,
    });

    expect(store.metadata.get(key)).toEqual({ sha256: part.sha256 });

    expect(store.objects.get(`${key}.sha256`)?.toString('utf8')).toBe(
      `${part.sha256}  part-000001.jsonl.gz\n`
    );

    await expect(access(part.path)).rejects.toThrow();
  });

  it('refuses a part whose gunzipped line count differs from what was written', async () => {
    const { store, layout } = memoryContext();
    const plan = keysetPlan('b', 'orders', idBrackets, 'raw/');
    const part = await closedPart(['{"_id":1}'], { lines: 2 });

    await expect(
      uploadPart(store, layout, plan, part, new AbortController().signal)
    ).rejects.toMatchObject({ msmCode: 'sha256' });

    expect(store.objects.size).toBe(0);
  });

  it('fails when the stored size differs from the uploaded one', async () => {
    const { store, layout } = memoryContext();
    const plan = keysetPlan('b', 'orders', idBrackets, 'raw/');
    const part = await closedPart(['{"_id":1}']);
    const lying = { ...store, head: async () => ({ bytes: part.bytes + 1, metadata: {} }) };

    await expect(
      uploadPart(lying, layout, plan, part, new AbortController().signal)
    ).rejects.toMatchObject({ msmCode: 's3' });
  });

  it('propagates an aborted upload', async () => {
    const { store, layout } = memoryContext();
    const plan = keysetPlan('b', 'orders', idBrackets, 'raw/');
    const part = await closedPart(['{"_id":1}']);
    const controller = new AbortController();

    controller.abort('SIGINT');

    await expect(uploadPart(store, layout, plan, part, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
