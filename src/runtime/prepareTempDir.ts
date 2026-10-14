import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Config } from '../types.js';
import msmError from './msmError.js';
import tempDirOf from './tempDirOf.js';

const refuse = (message: string) => msmError('config', message, { fatal: true });

/**
 * The scratch area of one command, wiped and recreated owner-only, after proving that the per-state directory
 * above it (`<tempDir>/<owner>`, a predictable name) is ours: a real directory, owned by this user, closed to
 * group and other. On a shared `tempDir` another local user could otherwise pre-create that directory (or a
 * symlink of that name) and then rename, replace or redirect every work file below it, so the start-up wipe
 * and the part downloads would act on paths that user controls. A `tempDir` root that others can write needs
 * the sticky bit for the same reason, whoever owns it: without it any user can rename our owner directory
 * away between the check and the first write and plant their own under that name. On platforms without uids
 * (Windows) only the shape is checked.
 */
export default async function prepareTempDir(config: Pick<Config, 'stateDir' | 'tempDir'>, area: 'export' | 'load' | 'reconcile'): Promise<string> {
  const areaDir = tempDirOf(config, area);
  const ownerDir = dirname(areaDir);
  const root = dirname(ownerDir);
  const uid = process.getuid?.();
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw refuse(`tempDir ${root} is not a directory`);
  if (uid !== undefined && (rootStat.mode & 0o022) !== 0 && (rootStat.mode & 0o1000) === 0) {
    throw refuse(`tempDir ${root} is writable by other users and has no sticky bit; another user could plant files under it. Point tempDir at a directory only this user can write, or one with the sticky bit set`);
  }
  await mkdir(ownerDir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err; });
  const ownerStat = await lstat(ownerDir);
  if (!ownerStat.isDirectory()) throw refuse(`${ownerDir} is not a directory (a symlink or file of that name was planted); remove it`);
  if (uid !== undefined) {
    if (ownerStat.uid !== uid) throw refuse(`${ownerDir} is owned by uid ${ownerStat.uid}, not this process (uid ${uid}); another user created it, so no file under it can be trusted. Remove it or use another tempDir`);
    if ((ownerStat.mode & 0o077) !== 0) throw refuse(`${ownerDir} is open to group or other (mode ${(ownerStat.mode & 0o777).toString(8)}); it must be 0700. Remove it or chmod it`);
  }
  await rm(areaDir, { recursive: true, force: true });
  await mkdir(areaDir, { mode: 0o700 });
  await chmod(areaDir, 0o700);
  return areaDir;
}
