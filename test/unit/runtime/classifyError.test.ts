import { MongoCompatibilityError, MongoNetworkError, MongoServerError, MongoServerSelectionError } from 'mongodb';
import { describe, expect, it } from 'vitest';
import classifyError from '../../../src/runtime/classifyError.js';
import msmError from '../../../src/runtime/msmError.js';
import runChunkAttempts from '../../../src/runtime/runChunkAttempts.js';
import { memoryContext } from '../../helpers.js';

const serverError = (code: number, labels: string[] = []) => new MongoServerError({ ok: 0, code, errmsg: `code ${code}`, errorLabels: labels });
const s3 = (name: string, status?: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status }, ...extra });
const mysql = (errno: number, code = 'ER_X') => Object.assign(new Error(`mysql ${errno}`), { errno, code, sqlState: 'HY000' });
const node = (code: string) => Object.assign(new Error(code), { code });

describe('classifyError', () => {
  it('reads tool errors from their fields', () => {
    expect(classifyError(msmError('config', 'x'))).toEqual({ code: 'config', retriable: false, chunkRetriable: false, fatal: false, aborted: false });
    expect(classifyError(msmError('insert_race', 'x'))).toMatchObject({ code: 'insert_race', retriable: true, chunkRetriable: true });
    expect(classifyError(msmError('count_mismatch', 'x'))).toMatchObject({ retriable: false, chunkRetriable: true, fatal: false });
    expect(classifyError(msmError('s3', 'x', { retriable: true, fatal: true }))).toMatchObject({ retriable: true, fatal: true });
    for (const code of ['config', 'record', 'parse', 'lock', 'interrupted'] as const) {
      expect(classifyError(msmError(code, 'x')).chunkRetriable).toBe(false);
    }
    expect(classifyError(msmError('interrupted', 'x'))).toMatchObject({ code: 'interrupted', aborted: true, fatal: false });
  });

  it('treats aborts as interrupted, never retried, never fatal', () => {
    const abort = Object.assign(new Error('Upload aborted.'), { name: 'AbortError' });
    expect(classifyError(abort)).toEqual({ code: 'interrupted', retriable: false, chunkRetriable: false, fatal: false, aborted: true });
  });

  it('retries transient Mongo errors and only the chunk on MaxTimeMSExpired', () => {
    expect(classifyError(new MongoNetworkError('reset'))).toMatchObject({ code: 'mongo', retriable: true, chunkRetriable: true, fatal: false });
    expect(classifyError(new MongoServerSelectionError('no primary', {} as never))).toMatchObject({ code: 'mongo', retriable: true });
    for (const code of [6, 7, 43, 89, 91, 189, 9001, 10107, 11600, 11602, 13435, 13436]) {
      expect(classifyError(serverError(code)).retriable, `code ${code}`).toBe(true);
    }
    expect(classifyError(serverError(12345, ['RetryableError'])).retriable).toBe(true);
    expect(classifyError(serverError(12345, ['ResetPool'])).retriable).toBe(true);
    expect(classifyError(serverError(50))).toMatchObject({ code: 'mongo', retriable: false, chunkRetriable: true, fatal: false });
    expect(classifyError(serverError(2))).toMatchObject({ code: 'mongo', retriable: false, chunkRetriable: true, fatal: false });
  });

  it('marks permission and compatibility errors fatal', () => {
    for (const code of [13, 18, 8000]) expect(classifyError(serverError(code))).toMatchObject({ code: 'mongo', fatal: true, retriable: false, chunkRetriable: false });
    expect(classifyError(new MongoCompatibilityError('wire version 7'))).toMatchObject({ code: 'config', fatal: true });
  });

  it('classifies S3 by name and status', () => {
    for (const name of ['AccessDenied', 'NoSuchBucket', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'CredentialsProviderError']) {
      expect(classifyError(s3(name, 403)), name).toMatchObject({ code: 's3', fatal: true, retriable: false });
    }
    // A HEAD response has no body, so the SDK names a 403 `Unknown`: the status alone makes it fatal (a write-only role must stop the run, not retry every chunk).
    expect(classifyError(s3('Unknown', 403))).toMatchObject({ code: 's3', fatal: true, retriable: false, chunkRetriable: false });
    expect(classifyError(s3('RequestTimeTooSkewed', 403))).toMatchObject({ code: 's3', fatal: true });
    expect(classifyError(s3('Unknown', 401))).toMatchObject({ code: 's3', fatal: true });
    expect(classifyError(s3('InternalError', 500))).toMatchObject({ code: 's3', retriable: true, chunkRetriable: true, fatal: false });
    expect(classifyError(s3('Throttling', 429))).toMatchObject({ code: 's3', retriable: true });
    expect(classifyError(s3('SlowDown', 503))).toMatchObject({ retriable: true });
    expect(classifyError(s3('RequestTimeout', 400))).toMatchObject({ retriable: true });
    expect(classifyError(s3('Whatever', 400, { $retryable: { throttling: true } }))).toMatchObject({ retriable: true });
    expect(classifyError(s3('NoSuchKey', 404))).toMatchObject({ code: 's3', retriable: false, chunkRetriable: true, fatal: false });
    // smithy's inactivity timeout carries no status; it is a transport failure worth another try.
    expect(classifyError(Object.assign(new Error('socket timeout'), { name: 'TimeoutError' }))).toMatchObject({ code: 's3', retriable: true, chunkRetriable: true, fatal: false });
  });

  it('classifies MySQL by errno', () => {
    for (const errno of [1044, 1045, 1049, 1054, 1142, 1146]) expect(classifyError(mysql(errno)), String(errno)).toMatchObject({ code: 'mysql', fatal: true });
    for (const errno of [1040, 1053, 1205, 1213, 1290, 1836, 2002, 2003, 2006, 2013]) expect(classifyError(mysql(errno)), String(errno)).toMatchObject({ code: 'mysql', retriable: true, fatal: false });
    expect(classifyError(Object.assign(new Error('lost'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true }))).toMatchObject({ code: 'mysql', retriable: true });
    // mysql2's "connection is in closed state" error has no code and no SQL state, only `fatal: true`.
    expect(classifyError(Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true }))).toMatchObject({ code: 'mysql', retriable: true, chunkRetriable: true, fatal: false });
    for (const errno of [1062, 1264, 1292, 1366, 1406, 3140]) expect(classifyError(mysql(errno)), String(errno)).toMatchObject({ code: 'mysql', retriable: false, chunkRetriable: true, fatal: false });
  });

  it('retries socket-level node errors and leaves the rest unknown', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN']) expect(classifyError(node(code)), code).toMatchObject({ retriable: true, chunkRetriable: true, fatal: false });
    expect(classifyError(new Error('boom'))).toEqual({ code: 'unknown', retriable: false, chunkRetriable: true, fatal: false, aborted: false });
    expect(classifyError('a string')).toMatchObject({ code: 'unknown' });
  });

  it('lets the first ENOSPC retry the chunk and makes the second fatal, which runChunkAttempts reports in the documented words', async () => {
    expect(classifyError(node('ENOSPC'))).toMatchObject({ code: 'disk', retriable: false, chunkRetriable: true, fatal: false });
    expect(classifyError(node('ENOSPC'))).toMatchObject({ code: 'disk', chunkRetriable: false, fatal: true });
    const { ctx } = memoryContext();
    await expect(runChunkAttempts(ctx, { chunk: 'c', collection: 'x' }, 3, async () => { throw node('ENOSPC'); }))
      .rejects.toMatchObject({ msmCode: 'disk', fatal: true, message: 'out of space twice; lower concurrency or partMaxBytesMb' });
  });
});
