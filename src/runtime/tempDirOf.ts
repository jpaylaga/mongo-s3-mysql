import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Config } from '#types';

/**
 * The scratch directory of one command: `<tempDir>/<owner>/<area>`, where `owner` is a hash of the
 * state directory. The locks live in `stateDir`, but `tempDir` may be a shared volume, so the
 * start-up wipe of an area must only touch the files of the run that holds this state directory's
 * lock.
 */
export default function tempDirOf(
  config: Pick<Config, 'stateDir' | 'tempDir'>,
  area: 'export' | 'load' | 'reconcile'
): string {
  const root = config.tempDir ?? join(config.stateDir, 'tmp');

  const owner = createHash('sha1')
    .update(resolve(config.stateDir), 'utf8')
    .digest('hex')
    .slice(0, 12);

  return join(root, owner, area);
}
