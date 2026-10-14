import { chmod, lstat, mkdir, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import prepareTempDir from '../../../src/runtime/prepareTempDir.js';
import tempDirOf from '../../../src/runtime/tempDirOf.js';
import { tmpDir } from '../../helpers.js';

const unix = process.getuid !== undefined;

describe('prepareTempDir', () => {
  it('creates <root>/<owner>/<area> owner-only and wipes a previous area', async () => {
    const stateDir = await tmpDir();
    const config = { stateDir, tempDir: join(stateDir, 'scratch') };
    const area = await prepareTempDir(config, 'export');
    expect(area).toBe(tempDirOf(config, 'export'));
    await writeFile(join(area, 'stale'), 'x');
    expect(await readdir(await prepareTempDir(config, 'export'))).toEqual([]);
    if (unix) {
      expect((await stat(area)).mode & 0o777).toBe(0o700);
      expect((await stat(dirname(area))).mode & 0o777).toBe(0o700);
    }
    // Another area of the same state directory is untouched.
    const load = await prepareTempDir(config, 'load');
    await writeFile(join(load, 'keep'), 'x');
    await prepareTempDir(config, 'export');
    expect(await readdir(load)).toEqual(['keep']);
  });

  it.skipIf(!unix)('refuses an owner directory another user could have planted: a symlink, or one open to group or other', async () => {
    const stateDir = await tmpDir();
    const config = { stateDir, tempDir: join(stateDir, 'scratch') };
    const owner = dirname(tempDirOf(config, 'export'));
    await mkdir(dirname(owner), { recursive: true });
    const elsewhere = await tmpDir();
    await symlink(elsewhere, owner);
    await expect(prepareTempDir(config, 'export')).rejects.toMatchObject({ msmCode: 'config', fatal: true, message: expect.stringContaining('is not a directory (a symlink or file of that name was planted)') });
    expect((await lstat(owner)).isSymbolicLink()).toBe(true);
    const open = { stateDir: await tmpDir() };
    const openOwner = dirname(tempDirOf(open, 'load'));
    await mkdir(openOwner, { recursive: true });
    await chmod(openOwner, 0o777);
    await expect(prepareTempDir(open, 'load')).rejects.toMatchObject({ msmCode: 'config', message: expect.stringMatching(/is open to group or other \(mode 777\); it must be 0700/) });
    await chmod(openOwner, 0o700);
    expect(await prepareTempDir(open, 'load')).toBe(tempDirOf(open, 'load'));
  });

  it.skipIf(!unix)('refuses a shared root that others can write without the sticky bit, even our own, and accepts a sticky one', async () => {
    const stateDir = await tmpDir();
    const root = join(stateDir, 'shared');
    await mkdir(root);
    // Owning the root does not help: without the sticky bit any user can rename our owner directory away and plant their own.
    await chmod(root, 0o777);
    await expect(prepareTempDir({ stateDir, tempDir: root }, 'export')).rejects.toMatchObject({ msmCode: 'config', fatal: true, message: expect.stringContaining('is writable by other users and has no sticky bit') });
    await chmod(root, 0o1777);
    expect(await prepareTempDir({ stateDir, tempDir: root }, 'export')).toBe(tempDirOf({ stateDir, tempDir: root }, 'export'));
    expect(await prepareTempDir({ stateDir, tempDir: root }, 'reconcile')).toBe(tempDirOf({ stateDir, tempDir: root }, 'reconcile'));
  });
});
