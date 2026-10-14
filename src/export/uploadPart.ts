import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import readGzipLines from '../ejson/readGzipLines.js';
import formatCount from '../runtime/formatCount.js';
import msmError from '../runtime/msmError.js';
import type { ChunkPlan, ClosedPart, Layout, ObjectStore, PartRef } from '../types.js';


/**
 * One closed part to S3: gunzip-test it first (a short read here is cheaper than a failed
 * load later), upload with the sha256 as metadata, confirm the stored size, write the `sha256sum`
 * sidecar, then drop the local file. Nothing here is a commit: the chunk manifest is.
 */
export default async function uploadPart(store: ObjectStore, layout: Layout, plan: ChunkPlan, part: ClosedPart, signal: AbortSignal): Promise<PartRef> {
  let lines = 0;
  for await (const _line of readGzipLines(createReadStream(part.path))) lines += 1;
  if (lines !== part.lines) {
    throw msmError('sha256', `${part.name}: gunzip test read ${formatCount(lines)} lines, ${formatCount(part.lines)} were written`);
  }

  const key = layout.part(plan.rawPrefix, part.n);
  await store.putFile(key, part.path, { contentType: 'application/gzip', metadata: { sha256: part.sha256 }, signal });
  const head = await store.head(key);
  if (head === null || head.bytes !== part.bytes) {
    throw msmError('s3', `${key}: stored ${head === null ? 'nothing' : `${formatCount(head.bytes)} bytes`}, uploaded ${formatCount(part.bytes)} bytes`);
  }
  const checksumKey = `${key}.sha256`;
  await store.putText(checksumKey, `${part.sha256}  ${part.name}\n`, 'text/plain');
  await unlink(part.path).catch(() => undefined);

  return {
    key, name: part.name, bytes: part.bytes, sha256: part.sha256,
    s3_uri: layout.uri(key), checksum_s3_uri: layout.uri(checksumKey), lines: part.lines,
  };
}
