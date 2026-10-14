import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import loadConfig from '../../../src/config/loadConfig.js';
import { exampleConfigJson, tmpDir } from '../../helpers.js';

describe('loadConfig', () => {
  it('reads and resolves relative to the file', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'mongo-s3-mysql.config.json');
    await writeFile(path, JSON.stringify(exampleConfigJson));
    const c = await loadConfig(path);
    expect(c.stateDir).toBe(join(dir, '.mongo-s3-mysql'));
    expect(c.mysql?.caFile).toBe(join(dir, 'global-bundle.pem'));
  });

  it('reports the line and column of invalid JSON without an excerpt', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'bad.json');
    await writeFile(path, '{\n  "mongo": { "database": "app" },\n  "s3": { "bucket": "b", "secret-ish": oops }\n}\n');
    await expect(loadConfig(path)).rejects.toThrow(new RegExp(`^${path.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}:3:\\d+: invalid JSON$`));
    await expect(loadConfig(path)).rejects.not.toThrow(/oops/);
  });

  it('locates other JSON faults: truncation, trailing garbage, bad escapes, control characters', async () => {
    const dir = await tmpDir();
    const cases: [string, string][] = [
      ['{"a": [1, 2', '1:12'], ['{"a": 1} x', '1:10'], ['{"a": "\\q"}', '1:9'], ['{"a":\n"x\ty"}', '2:3'], ['', '1:1'], ['{"a": 01}', '1:8'],
    ];
    for (const [text, where] of cases) {
      const path = join(dir, `${where.replace(':', '-')}-${cases.indexOf([text, where] as never)}.json`);
      await writeFile(path, text);
      await expect(loadConfig(path), JSON.stringify(text)).rejects.toThrow(`${path}:${where}: invalid JSON`);
    }
  });

  it('drops a leading byte order mark, as mapping files and S3 records do', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'bom.json');
    await writeFile(path, `\ufeff${JSON.stringify(exampleConfigJson)}`);
    expect((await loadConfig(path)).mongo.database).toBe('app');
  });

  it('propagates a missing file', async () => {
    await expect(loadConfig('/nonexistent/msm.json')).rejects.toThrow(/ENOENT/);
  });
});
