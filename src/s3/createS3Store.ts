import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import {
  GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
  type PutObjectCommandInput, type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import msmError from '../runtime/msmError.js';
import withRetry from '../runtime/withRetry.js';
import type { ObjectStore, RunContext, S3Config } from '../types.js';
import idleWatchdog from './idleWatchdog.js';
import recordLimitBytes from './recordLimitBytes.js';

const missing = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
};

/** A HEAD response has no body, so the SDK names a 403 `Unknown`; the status is the only thing that says what happened. */
const forbidden = (err: unknown): boolean => (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 403;

// Inactivity timeouts for the request phase. The SDK clears its socket timer once the response headers arrive,
// so every body the store hands out or reads is wrapped in `idleWatchdog` with the same limit; its TimeoutError retries.
const requestHandlerOptions = { connectionTimeout: 10_000, socketTimeout: 120_000 } as const;

/** A body larger than the caller's limit is read no further: a record that size is damage or an attack, never a manifest. */
async function readCapped(body: Readable, key: string, contentLength: number | undefined, maxBytes: number): Promise<string> {
  if (contentLength !== undefined && contentLength > maxBytes) {
    body.destroy();
    throw msmError('record', `${key}: ${contentLength} bytes exceeds the ${maxBytes}-byte record limit`);
  }
  let seen = 0;
  body.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > maxBytes) body.destroy(msmError('record', `${key}: more than ${maxBytes} bytes exceeds the record limit`));
  });
  return text(body);
}

/**
 * The real `ObjectStore`. Flexible checksums are off because S3-compatible stores reject them and the tool
 * carries its own sha256 anyway; every call retries through `withRetry` (the SDK's own 3 attempts are for the
 * per-request transport layer), including the body read of `getText`, since a reset after the headers is as
 * transient as one before them. The storage class applies to raw parts only: the small records are rewritten
 * often and would each be billed at an infrequent-access class's minimum size and duration.
 */
export default function createS3Store(s3: S3Config, ctx: RunContext, client?: S3Client): ObjectStore {
  const config: S3ClientConfig = {
    maxAttempts: 3, forcePathStyle: s3.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: requestHandlerOptions,
    ...(s3.region ? { region: s3.region } : {}), ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
  };
  const c = client ?? new S3Client(config);
  const Bucket = s3.bucket;
  const encryption = (): Pick<PutObjectCommandInput, 'ServerSideEncryption' | 'SSEKMSKeyId'> => ({
    ...(s3.sse === 'none' ? {} : { ServerSideEncryption: s3.sse }),
    ...(s3.sse === 'aws:kms' && s3.kmsKeyId ? { SSEKMSKeyId: s3.kmsKeyId } : {}),
  });
  const retry = <T>(name: string, fn: () => Promise<T>) => withRetry(ctx, { source: 's3', name }, fn);

  return {
    bucket: Bucket,
    async putFile(key, path, opts) {
      await retry('putFile', async () => {
        if (opts.signal?.aborted) throw Object.assign(new Error('Upload aborted.'), { name: 'AbortError' });
        const abortController = new AbortController();
        const onAbort = () => abortController.abort();
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          // A fresh stream per try: a retried multipart upload cannot rewind a consumed one.
          const upload = new Upload({
            client: c, queueSize: s3.queueSize, partSize: s3.partSizeMb * 1024 * 1024, abortController,
            params: { Bucket, Key: key, Body: createReadStream(path), ContentType: opts.contentType, Metadata: opts.metadata, StorageClass: s3.storageClass, ...encryption() },
          });
          await upload.done();
        } finally {
          opts.signal?.removeEventListener('abort', onAbort);
        }
      });
    },
    async putText(key, body, contentType) {
      await retry('putText', () => c.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType, ...encryption() })));
      return createHash('sha256').update(body, 'utf8').digest('hex');
    },
    async head(key) {
      try {
        const out = await retry('head', () => c.send(new HeadObjectCommand({ Bucket, Key: key })));
        return { bytes: out.ContentLength ?? 0 };
      } catch (err) {
        if (missing(err)) return null;
        if (forbidden(err)) throw msmError('s3', `${key}: HeadObject returned 403 (the role needs s3:GetObject on the prefix)`, { fatal: true, cause: err });
        throw err;
      }
    },
    async getText(key, maxBytes = recordLimitBytes) {
      try {
        return await retry('getText', async () => {
          const out = await c.send(new GetObjectCommand({ Bucket, Key: key }));
          if (!out.Body) return '';
          return readCapped(idleWatchdog(out.Body as Readable, requestHandlerOptions.socketTimeout, key), key, out.ContentLength, maxBytes);
        });
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    async getStream(key) {
      try {
        const out = await retry('getStream', () => c.send(new GetObjectCommand({ Bucket, Key: key })));
        return out.Body ? idleWatchdog(out.Body as Readable, requestHandlerOptions.socketTimeout, key) : null;
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    async list(prefix, delimiter) {
      const keys: string[] = [];
      const prefixes: string[] = [];
      let token: string | undefined;
      do {
        const page = await retry('list', () => c.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, Delimiter: delimiter, ContinuationToken: token })));
        for (const o of page.Contents ?? []) if (o.Key !== undefined) keys.push(o.Key);
        for (const p of page.CommonPrefixes ?? []) if (p.Prefix !== undefined) prefixes.push(p.Prefix);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
      return { keys, prefixes };
    },
  };
}
