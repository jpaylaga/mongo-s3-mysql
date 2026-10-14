import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import readGzipLines from '#ejson/readGzipLines';
import { gz, readFixture } from '../../helpers.js';

const collect = async (buf: Buffer, chunk = buf.length) => {
  const pieces: Buffer[] = [];

  for (let i = 0; i < buf.length; i += chunk) pieces.push(buf.subarray(i, i + chunk));

  const lines: string[] = [];

  for await (const line of readGzipLines(Readable.from(pieces))) lines.push(line);

  return lines;
};

describe('readGzipLines', () => {
  it('yields lines without newlines, across chunk boundaries', async () => {
    const text = 'first\nsecond line\n\nfourth\n';

    expect(await collect(gz(text))).toEqual(['first', 'second line', '', 'fourth']);
    expect(await collect(gz(text), 3)).toEqual(['first', 'second line', '', 'fourth']);
  });

  it('strips a leading BOM and tolerates a missing final newline', async () => {
    expect(await collect(gz('﻿{"a":1}\n{"b":2}'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(await collect(gz(''))).toEqual([]);
    expect(await collect(gz('﻿'))).toEqual([]);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const text = 'café ☃ \u{1F600}\n';

    expect(await collect(gz(text), 1)).toEqual([text.slice(0, -1)]);
  });

  it('fails on invalid UTF-8 with a parse error and on a non-gzip body', async () => {
    const bad = require('node:zlib').gzipSync(Buffer.from([0x61, 0xff, 0x62, 0x0a]));

    await expect(collect(bad)).rejects.toMatchObject({ msmCode: 'parse' });
    await expect(collect(Buffer.from('not gzip at all'))).rejects.toThrow();
  });

  it('scans only new text for newlines, so long lines stay linear, and caps a line', async () => {
    const line = 'x'.repeat(8 * 1024 * 1024);
    const started = Date.now();

    expect((await collect(gz(`${line}\n${line}\n`), 16 * 1024)).map(l => l.length)).toEqual([
      line.length,
      line.length,
    ]);

    expect(Date.now() - started).toBeLessThan(5_000);

    const capped: string[] = [];

    await expect(
      (async () => {
        for await (const l of readGzipLines(Readable.from([gz(`${'y'.repeat(2000)}\n`)]), 1000))
          capped.push(l);
      })()
    ).rejects.toMatchObject({ msmCode: 'parse', message: 'line longer than 0 MiB' });

    const fits: number[] = [];

    for await (const l of readGzipLines(
      Readable.from([gz(`${'y'.repeat(900)}\n${'z'.repeat(900)}`)]),
      1000
    ))
      fits.push(l.length);

    expect(fits).toEqual([900, 900]);
  });

  it('reads the sample fixture through a gzip round trip', async () => {
    const lines = await collect(gz(await readFixture('audit_log.sample.jsonl')));

    expect(lines).toHaveLength(12);
    expect(JSON.parse(lines[0] as string)._id.$oid).toMatch(/^[0-9a-f]{24}$/);
  });
});
