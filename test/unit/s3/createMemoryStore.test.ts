import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import createMemoryStore from '../../../src/s3/createMemoryStore.js';
import { tmpDir } from '../../helpers.js';

describe('createMemoryStore', () => {
  it('stores text, reports its sha256, heads and streams it', async () => {
    const store = createMemoryStore();
    expect(store.bucket).toBe('example-archive-bucket');
    const sha = await store.putText('a/b.json', '{"x":1}', 'application/json');
    expect(sha).toBe(createHash('sha256').update('{"x":1}').digest('hex'));
    expect(await store.head('a/b.json')).toEqual({ bytes: 7 });
    expect(await store.getText('a/b.json')).toBe('{"x":1}');
    const chunks: Buffer[] = [];
    for await (const c of (await store.getStream('a/b.json'))!) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('{"x":1}');
    expect(await store.head('missing')).toBeNull();
    expect(await store.getText('missing')).toBeNull();
    expect(await store.getStream('missing')).toBeNull();
  });

  it('uploads a file with metadata and honours an aborted signal', async () => {
    const store = createMemoryStore('other');
    const dir = await tmpDir();
    const path = join(dir, 'part.gz');
    await writeFile(path, Buffer.from([1, 2, 3]));
    await store.putFile('raw/part.gz', path, { contentType: 'application/gzip', metadata: { sha256: 'abc' } });
    expect(await store.head('raw/part.gz')).toEqual({ bytes: 3 });
    expect(store.metadata.get('raw/part.gz')).toEqual({ sha256: 'abc' });
    expect(store.objects.get('raw/part.gz')).toEqual(Buffer.from([1, 2, 3]));
    const controller = new AbortController();
    controller.abort();
    await expect(store.putFile('raw/again.gz', path, { contentType: 'application/gzip', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await store.head('raw/again.gz')).toBeNull();
  });

  it('lists with S3 prefix and delimiter semantics', async () => {
    const store = createMemoryStore();
    for (const k of ['m/collection=a/run_id=1.json', 'm/collection=a/run_id=2.json', 'm/collection=b/run_id=1.json', 'm/run_id=batch.json', 'other/x']) {
      await store.putText(k, '{}', 'application/json');
    }
    expect(await store.list('m/')).toEqual({ keys: ['m/collection=a/run_id=1.json', 'm/collection=a/run_id=2.json', 'm/collection=b/run_id=1.json', 'm/run_id=batch.json'], prefixes: [] });
    expect(await store.list('m/', '/')).toEqual({ keys: ['m/run_id=batch.json'], prefixes: ['m/collection=a/', 'm/collection=b/'] });
    expect(await store.list('m/collection=a/run_id=')).toEqual({ keys: ['m/collection=a/run_id=1.json', 'm/collection=a/run_id=2.json'], prefixes: [] });
    expect(await store.list('zzz/')).toEqual({ keys: [], prefixes: [] });
  });
});
