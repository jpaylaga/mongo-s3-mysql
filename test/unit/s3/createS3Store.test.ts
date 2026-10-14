import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import createS3Store from '../../../src/s3/createS3Store.js';
import { exampleConfig, exampleConfigJson, memoryContext, tmpDir } from '../../helpers.js';

// The real constructor is kept for every test that passes its own client; the spy only records what createS3Store builds.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  // A `function`, not an arrow: createS3Store calls `new S3Client(config)`.
  return { ...actual, S3Client: vi.fn(function S3Client(config: unknown) { return new actual.S3Client(config as never); }) };
});

type Sent = { name: string; input: Record<string, any> };

/** A scripted S3 client: `handle` answers each command by its constructor name; every call is recorded. */
function stubClient(handle: (name: string, input: Record<string, any>, options: { abortSignal?: AbortSignal } | undefined) => unknown) {
  const sent: Sent[] = [];
  const client = {
    // Upload reads the endpoint for its Location string and the checksum setting before a multipart start.
    config: {
      endpoint: async () => ({ protocol: 'https:', hostname: 's3.us-east-1.amazonaws.com', path: '/' }),
      forcePathStyle: false, requestChecksumCalculation: async () => 'WHEN_REQUIRED', requestHandler: {},
    },
    async send(command: { constructor: { name: string }; input: Record<string, any> }, options?: { abortSignal?: AbortSignal }) {
      sent.push({ name: command.constructor.name, input: command.input });
      return handle(command.constructor.name, command.input, options);
    },
  };
  return { client: client as unknown as S3Client, sent };
}

const notFound = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe('createS3Store', () => {
  afterEach(() => vi.useRealTimers());

  it('maps NotFound and NoSuchKey to null and returns bodies otherwise', async () => {
    const { ctx } = memoryContext();
    const { client } = stubClient((name, input) => {
      if (input.Key === 'missing') throw notFound(name === 'HeadObjectCommand' ? 'NotFound' : 'NoSuchKey', 404);
      if (name === 'HeadObjectCommand') return { ContentLength: 42, Metadata: { sha256: 'abc' } };
      if (name === 'GetObjectCommand') return { Body: Object.assign(Readable.from([Buffer.from('hello')]), { transformToString: async () => 'hello' }) };
      return {};
    });
    const store = createS3Store(exampleConfig().s3, ctx, client);
    expect(store.bucket).toBe('example-archive-bucket');
    expect(await store.head('missing')).toBeNull();
    expect(await store.getText('missing')).toBeNull();
    expect(await store.getStream('missing')).toBeNull();
    expect(await store.head('k')).toEqual({ bytes: 42 });
    expect(await store.getText('k')).toBe('hello');
    const chunks: Buffer[] = [];
    for await (const c of (await store.getStream('k'))!) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });

  it('builds its own client with request timeouts; the bodies get their own idle watchdog below', () => {
    const { ctx } = memoryContext();
    vi.mocked(S3Client).mockClear();
    const store = createS3Store(exampleConfig({ s3: { ...exampleConfigJson.s3, endpoint: 'https://s3.example.test', forcePathStyle: true } }).s3, ctx);
    expect(store.bucket).toBe('example-archive-bucket');
    expect(vi.mocked(S3Client)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(S3Client).mock.calls[0]?.[0]).toEqual({
      maxAttempts: 3, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: { connectionTimeout: 10_000, socketTimeout: 120_000 }, region: 'us-east-1', endpoint: 'https://s3.example.test',
    });
    // With a client passed in, none is built.
    createS3Store(exampleConfig().s3, ctx, stubClient(() => ({})).client);
    expect(vi.mocked(S3Client)).toHaveBeenCalledTimes(1);
  });

  it('pages ListObjectsV2 with the continuation token and passes the delimiter', async () => {
    const { ctx } = memoryContext();
    const { client, sent } = stubClient((_name, input) => {
      if (input.ContinuationToken === undefined) return { Contents: [{ Key: 'a' }, { Key: 'b' }], CommonPrefixes: [{ Prefix: 'p/' }], IsTruncated: true, NextContinuationToken: 't2' };
      return { Contents: [{ Key: 'c' }], IsTruncated: false };
    });
    const store = createS3Store(exampleConfig().s3, ctx, client);
    expect(await store.list('pre', '/')).toEqual({ keys: ['a', 'b', 'c'], prefixes: ['p/'] });
    expect(sent.map((s) => s.input.ContinuationToken)).toEqual([undefined, 't2']);
    expect(sent[0]?.input).toMatchObject({ Bucket: 'example-archive-bucket', Prefix: 'pre', Delimiter: '/' });
  });

  it('retries transient failures through withRetry and surfaces fatal ones at once', async () => {
    const { ctx, events } = memoryContext();
    let calls = 0;
    const { client } = stubClient(() => {
      calls += 1;
      if (calls === 1) throw notFound('SlowDown', 503);
      if (calls === 2) throw notFound('AccessDenied', 403);
      return { Contents: [], IsTruncated: false };
    });
    const store = createS3Store(exampleConfig().s3, ctx, client);
    await expect(store.list('x')).rejects.toMatchObject({ name: 'AccessDenied' });
    expect(calls).toBe(2);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
  });

  it('putText returns the body sha256 and carries the SSE settings but not the storage class, which is for raw parts only', async () => {
    const { ctx } = memoryContext();
    const { client, sent } = stubClient(() => ({}));
    const s3 = exampleConfig({ s3: { bucket: 'b-b-b', storageClass: 'STANDARD_IA', sse: 'aws:kms', kmsKeyId: 'key-1' } }).s3;
    const store = createS3Store(s3, ctx, client);
    expect(await store.putText('k', 'body', 'application/json')).toBe(createHash('sha256').update('body').digest('hex'));
    expect(sent[0]).toMatchObject({ name: 'PutObjectCommand', input: { Bucket: 'b-b-b', Key: 'k', Body: 'body', ContentType: 'application/json', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'key-1' } });
    expect((sent[0] as { input: Record<string, unknown> }).input).not.toHaveProperty('StorageClass');
    const plain = createS3Store(exampleConfig().s3, ctx, stubClient(() => ({})).client);
    await plain.putText('k', 'x', 'text/plain');
  });

  it('putFile uploads through lib-storage with metadata and aborts on the signal', async () => {
    const { ctx } = memoryContext();
    const dir = await tmpDir();
    const path = join(dir, 'part.gz');
    await writeFile(path, Buffer.from('gzip bytes'));
    const { client, sent } = stubClient(() => ({ ETag: '"x"' }));
    const store = createS3Store(exampleConfig().s3, ctx, client);
    await store.putFile('raw/part.gz', path, { contentType: 'application/gzip', metadata: { sha256: 'abc' } });
    const put = sent.find((s) => s.name === 'PutObjectCommand');
    expect(put?.input).toMatchObject({ Key: 'raw/part.gz', ContentType: 'application/gzip', Metadata: { sha256: 'abc' }, StorageClass: 'STANDARD' });

    const controller = new AbortController();
    const slow = stubClient((_n, _i, options) => new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('Upload aborted.'), { name: 'AbortError' })));
      setTimeout(() => controller.abort('SIGINT'), 5);
    }));
    const aborted = createS3Store(exampleConfig().s3, ctx, slow.client);
    await expect(aborted.putFile('raw/part.gz', path, { contentType: 'application/gzip', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(aborted.putFile('raw/part.gz', path, { contentType: 'application/gzip', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

it('names the missing permission when HeadObject returns 403, which the SDK reports as Unknown', async () => {
    const { ctx } = memoryContext();
    const { client } = stubClient(() => { throw Object.assign(new Error('UnknownError'), { name: 'Unknown', $metadata: { httpStatusCode: 403 } }); });
    const store = createS3Store(exampleConfig().s3, ctx, client);
    await expect(store.head('raw/part.gz')).rejects.toMatchObject({ msmCode: 's3', fatal: true, message: 'raw/part.gz: HeadObject returned 403 (the role needs s3:GetObject on the prefix)' });
  });

  it('retries getText when the body read fails after the headers, not only the request itself', async () => {
    const { ctx, events } = memoryContext();
    let reads = 0;
    const { client } = stubClient(() => {
      reads += 1;
      if (reads === 1) {
        const body = new Readable({ read() { this.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })); } });
        return { Body: body };
      }
      return { Body: Readable.from([Buffer.from('whole body')]) };
    });
    const store = createS3Store(exampleConfig().s3, ctx, client);
    expect(await store.getText('m.json')).toBe('whole body');
    expect(reads).toBe(2);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
  });

  it('a body that stalls after the headers fails with a retriable TimeoutError once the idle limit passes, for getText and getStream alike', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { ctx } = memoryContext({ config: exampleConfig({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 2 } }) });
    // Headers and a first chunk arrive at once, then nothing: the SDK's own socket timer was already cleared by then.
    const stalled = () => { const body = new Readable({ read() {} }); body.push(Buffer.from('partial')); return body; };
    const { client } = stubClient(() => ({ Body: stalled() }));
    const store = createS3Store(exampleConfig().s3, ctx, client);
    const pending = store.getText('m.json');
    const outcome = pending.then(() => 'resolved', (err: Error) => err);
    await vi.advanceTimersByTimeAsync(119_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await outcome;
    expect(err).toMatchObject({ name: 'TimeoutError', message: 'm.json: S3 body idle for 120000 ms' });
    const stream = await store.getStream('part.gz');
    const chunks: Buffer[] = [];
    const failed = new Promise<Error>((resolve) => { stream?.on('error', resolve); });
    stream?.on('data', (c: Buffer) => chunks.push(c));
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await failed).toMatchObject({ name: 'TimeoutError' });
    expect(Buffer.concat(chunks).toString()).toBe('partial');
    // A body that keeps delivering never trips: each byte refreshes the timer.
    const steady = new Readable({ read() {} });
    const { client: live } = stubClient(() => ({ Body: steady }));
    const text = createS3Store(exampleConfig().s3, ctx, live).getText('slow.json');
    for (let i = 0; i < 5; i += 1) {
      steady.push(Buffer.from('x'));
      await vi.advanceTimersByTimeAsync(100_000);
    }
    steady.push(null);
    expect(await text).toBe('xxxxx');
  });

  it('caps a record read: an object beyond the limit (by its length header or by its bytes) is a record error, never a huge string', async () => {
    const { ctx } = memoryContext({ config: exampleConfig({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 2 } }) });
    const { client } = stubClient((_name, input) => {
      if (input.Key === 'declared') return { Body: Readable.from([Buffer.from('tiny')]), ContentLength: 70 * 1024 * 1024 };
      if (input.Key === 'undeclared') return { Body: Readable.from([Buffer.alloc(600), Buffer.alloc(600)]) };
      return { Body: Readable.from([Buffer.from('ok')]), ContentLength: 2 };
    });
    const store = createS3Store(exampleConfig().s3, ctx, client);
    await expect(store.getText('declared')).rejects.toMatchObject({ msmCode: 'record', message: `declared: ${70 * 1024 * 1024} bytes exceeds the ${64 * 1024 * 1024}-byte record limit` });
    await expect(store.getText('undeclared', 1024)).rejects.toMatchObject({ msmCode: 'record', message: 'undeclared: more than 1024 bytes exceeds the record limit' });
    expect(await store.getText('small', 1024)).toBe('ok');
  });
});
