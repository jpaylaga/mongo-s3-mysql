import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import createHashCounter from '../../../src/runtime/createHashCounter.js';

describe('createHashCounter', () => {
  it('passes bytes through while feeding a sha256 and a byte count', async () => {
    const counter = createHashCounter();
    const out: Buffer[] = [];
    await pipeline(Readable.from([Buffer.from('hel'), Buffer.from('lo')]), counter.stream, async function* (source) { for await (const c of source) out.push(c as Buffer); });
    expect(Buffer.concat(out).toString()).toBe('hello');
    expect(counter.bytes()).toBe(5);
    expect(counter.digest()).toBe(createHash('sha256').update('hello').digest('hex'));
  });

  it('with a limit, fails the stream as soon as more bytes than that pass', async () => {
    const counter = createHashCounter({ bytes: 4, name: 'part-000001.jsonl.gz' });
    counter.stream.resume();
    await expect(pipeline(Readable.from([Buffer.from('hel'), Buffer.from('lo'), Buffer.from('!')]), counter.stream))
      .rejects.toMatchObject({ msmCode: 'sha256', message: 'part-000001.jsonl.gz: more than the 4 bytes the manifest says' });
    const exact = createHashCounter({ bytes: 5, name: 'p' });
    exact.stream.resume();
    await pipeline(Readable.from([Buffer.from('hello')]), exact.stream);
    expect(exact.bytes()).toBe(5);
  });
});
