import { createWriteStream } from 'node:fs';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import checkFreeSpace from '../runtime/checkFreeSpace.js';
import createHashCounter from '../runtime/createHashCounter.js';
import formatCount from '../runtime/formatCount.js';
import msmError from '../runtime/msmError.js';
import type { ObjectStore, PartRef } from '../types.js';

/**
 * One part from S3 to a local file, streamed through a sha256. The reservation covers the
 * bytes while they are in flight; once the file is closed statfs sees them, so it is released here and the
 * caller only has to unlink. Bytes and digest must equal the manifest's, whether or not verify ran, and the
 * stream stops as soon as it passes the manifest's size, so a larger object never overruns the reservation.
 * The local `path` is the caller's: never derived from the manifest's part name. A part whose `s3_uri` is
 * outside the chunk's raw prefix (`key` null) is a record error, and S3 is not asked for it.
 */
export default async function downloadPart(store: ObjectStore, part: PartRef, path: string, minFreeMb: number): Promise<void> {
  if (part.key === null) throw msmError('record', `${part.name}: s3_uri ${part.s3_uri} is outside the chunk's raw prefix`);
  // Downloaded documents are often personal data and tempDir may be a shared volume: owner-only all the way down.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const release = await checkFreeSpace(dirname(path), minFreeMb, part.bytes);
  try {
    const source = await store.getStream(part.key);
    if (source === null) throw msmError('record', `${part.name}: object ${part.key} is missing`);

    const counter = createHashCounter({ bytes: part.bytes, name: part.name });
    // Owner-only, and never an existing path: `wx` refuses a file or symlink planted at the part's name.
    await pipeline(source, counter.stream, createWriteStream(path, { mode: 0o600, flags: 'wx' }));

    const digest = counter.digest();
    if (counter.bytes() !== part.bytes) throw msmError('sha256', `${part.name}: downloaded ${formatCount(counter.bytes())} bytes, manifest says ${formatCount(part.bytes)}`);
    if (digest !== part.sha256) throw msmError('sha256', `${part.name}: sha256 ${digest.slice(0, 12)} differs from the manifest's ${part.sha256.slice(0, 12)}`);
  } catch (err) {
    await unlink(path).catch(() => undefined);
    throw err;
  } finally {
    release();
  }
}
