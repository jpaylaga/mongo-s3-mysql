import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import createPartWriter from '#export/createPartWriter';
import { tmpDir } from '../../helpers.js';

const writer = async (over: Partial<Parameters<typeof createPartWriter>[0]> = {}) => {
  const dir = await tmpDir();

  return {
    dir,
    w: createPartWriter({
      dir,
      gzipLevel: 6,
      maxDocs: 1000,
      maxBytes: 1024 * 1024,
      minFreeMb: 0,
      ...over,
    }),
  };
};

describe('createPartWriter', () => {
  it('rotates at maxDocs, numbers parts, reports sha256, bytes and lines per part', async () => {
    const { dir, w } = await writer({ maxDocs: 2 });
    const closed = [];

    for (const line of ['{"_id":1}', '{"_id":2}', '{"_id":3}']) {
      const c = await w.write(line);

      if (c !== null) closed.push(c);
    }

    const last = await w.finish();

    expect(last).not.toBeNull();
    closed.push(last!);

    expect(closed.map(c => [c.n, c.name, c.lines])).toEqual([
      [1, 'part-000001.jsonl.gz', 2],
      [2, 'part-000002.jsonl.gz', 1],
    ]);

    for (const c of closed) {
      const file = await readFile(c.path);

      expect(c.bytes).toBe((await stat(c.path)).size);
      expect(c.sha256).toBe(createHash('sha256').update(file).digest('hex'));
    }

    expect(gunzipSync(await readFile(closed[0]!.path)).toString('utf8')).toBe(
      '{"_id":1}\n{"_id":2}\n'
    );

    expect(gunzipSync(await readFile(closed[1]!.path)).toString('utf8')).toBe('{"_id":3}\n');
    expect((await readdir(dir)).sort()).toEqual(['part-000001.jsonl.gz', 'part-000002.jsonl.gz']);
  });

  it('rotates on uncompressed bytes and finishes with null when nothing is pending', async () => {
    const { w } = await writer({ maxBytes: 20 });

    expect(await w.write('{"_id":"aaaaaaaa"}')).toBeNull();

    const first = await w.write('{"_id":"bbbbbbbb"}');

    expect(first?.lines).toBe(2);
    expect(await w.finish()).toBeNull();

    const { w: empty } = await writer();

    expect(await empty.finish()).toBeNull();
  });

  it('abort removes the open part so a retry starts clean', async () => {
    const { dir, w } = await writer();

    await w.write('{"_id":1}');
    await w.abort();
    expect(await readdir(dir)).toEqual([]);
    await w.abort();
  });

  it('streams a part larger than the pipe buffer without buffering it whole', async () => {
    const { w } = await writer({ maxDocs: 100_000, maxBytes: 64 * 1024 * 1024 });
    const line = `{"_id":1,"pad":"${'x'.repeat(5000)}"}`;

    for (let i = 0; i < 2000; i += 1) await w.write(line);

    const part = await w.finish();

    expect(part?.lines).toBe(2000);
    expect(gunzipSync(await readFile(part!.path)).length).toBe(2000 * (line.length + 1));
  });
});
