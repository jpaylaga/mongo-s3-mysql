import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { HashCounter } from '../types.js';
import msmError from './msmError.js';

/**
 * A pass-through stream that feeds a sha256 and counts bytes, for parts on their way to or from S3. With a
 * `limit`, the stream fails as soon as more bytes than that pass: a part larger than its manifest says must
 * not be streamed to the end (into a disk reservation sized by the manifest) before the mismatch is reported.
 */
export default function createHashCounter(limit?: { bytes: number; name: string }): HashCounter {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      if (limit !== undefined && bytes > limit.bytes) {
        callback(msmError('sha256', `${limit.name}: more than the ${limit.bytes} bytes the manifest says`));
        return;
      }
      callback(null, chunk);
    },
  });
  return { stream, digest: () => hash.digest('hex'), bytes: () => bytes };
}
