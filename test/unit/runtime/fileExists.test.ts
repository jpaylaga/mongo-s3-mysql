import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fileExists from '../../../src/runtime/fileExists.js';
import { tmpDir } from '../../helpers.js';

describe('fileExists', () => {
  it('is true for a reachable path and false for a missing one', async () => {
    const dir = await tmpDir();
    await writeFile(join(dir, 'a'), 'x');
    expect(await fileExists(join(dir, 'a'))).toBe(true);
    expect(await fileExists(dir)).toBe(true);
    expect(await fileExists(join(dir, 'missing'))).toBe(false);
  });
});
