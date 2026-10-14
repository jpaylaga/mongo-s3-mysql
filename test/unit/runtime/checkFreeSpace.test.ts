import { statfs } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import checkFreeSpace from '#runtime/checkFreeSpace';
import { tmpDir } from '../../helpers.js';

describe('checkFreeSpace', () => {
  it('passes with a small minimum and reserves bytes process-wide until released', async () => {
    const dir = await tmpDir();
    const stats = await statfs(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    // Reserve about 60% of what is free: a second identical reservation must then fail.
    const chunk = Math.floor(free * 0.6);
    const release = await checkFreeSpace(dir, 0, chunk);

    await expect(checkFreeSpace(dir, 0, chunk)).rejects.toMatchObject({ msmCode: 'disk' });
    release();
    release();

    const again = await checkFreeSpace(dir, 0, chunk);

    again();
  });

  it('fails when the minimum alone exceeds the free space and names the numbers', async () => {
    const dir = await tmpDir();

    await expect(checkFreeSpace(dir, 2 ** 40)).rejects.toThrow(
      /MB free, .* MB needed .*minFreeDiskMb/
    );

    const release = await checkFreeSpace(dir, 0);

    release();
  });
});
