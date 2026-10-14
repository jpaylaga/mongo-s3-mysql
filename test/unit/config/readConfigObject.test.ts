import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import readConfigObject from '#config/readConfigObject';
import { exampleConfigJson, tmpDir } from '../../helpers.js';

describe('readConfigObject', () => {
  it('returns the parsed object and drops a byte order mark', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'mongo-s3-mysql.config.json');

    await writeFile(path, `\ufeff${JSON.stringify(exampleConfigJson)}`);
    expect(await readConfigObject(path)).toEqual(exampleConfigJson);
  });

  it('reports the line and column of invalid JSON without an excerpt', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'bad.json');

    await writeFile(
      path,
      '{\n  "mongo": { "database": "app" },\n  "s3": { "bucket": "b", "secret-ish": oops }\n}\n'
    );

    await expect(readConfigObject(path)).rejects.toThrow(
      new RegExp(`^${path.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}:3:\\d+: invalid JSON$`)
    );

    await expect(readConfigObject(path)).rejects.not.toThrow(/oops/);
  });

  it('locates other JSON faults: truncation, extra text, bad escapes, control chars', async () => {
    const dir = await tmpDir();

    const cases: [string, string][] = [
      ['{"a": [1, 2', '1:12'],
      ['{"a": 1} x', '1:10'],
      ['{"a": "\\q"}', '1:9'],
      ['{"a":\n"x\ty"}', '2:3'],
      ['', '1:1'],
      ['{"a": 01}', '1:8'],
    ];

    for (const [text, where] of cases) {
      const path = join(
        dir,
        `${where.replace(':', '-')}-${cases.indexOf([text, where] as never)}.json`
      );

      await writeFile(path, text);

      await expect(readConfigObject(path), JSON.stringify(text)).rejects.toThrow(
        `${path}:${where}: invalid JSON`
      );
    }
  });

  it('propagates a missing file', async () => {
    await expect(readConfigObject('/nonexistent/msm.json')).rejects.toThrow(/ENOENT/);
  });
});
