import { access } from 'node:fs/promises';

/** Whether a path can be reached at all; the caller decides what a missing file means. */
export default function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
