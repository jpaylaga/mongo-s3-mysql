import { MongoCompatibilityError, MongoError, MongoNetworkError, MongoServerSelectionError } from 'mongodb';
import type { ErrorClass, FailureCode } from '../types.js';
import isMsmError from './isMsmError.js';

// The driver's retryable-read code set (retryable-reads spec) plus the ones the retry table in docs/operations.md names.
const mongoRetryable = new Set([6, 7, 43, 89, 91, 189, 9001, 10107, 11600, 11602, 13435, 13436, 134, 262]);
const mongoFatal = new Set([13, 18, 8000]);
const s3Fatal = new Set(['AccessDenied', 'NoSuchBucket', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'CredentialsProviderError']);
// TimeoutError is what smithy's request handler throws when a socket stays idle past the configured timeout.
const s3Retryable = new Set(['SlowDown', 'RequestTimeout', 'InternalError', 'ServiceUnavailable', 'TooManyRequests', 'TimeoutError']);
const mysqlFatal = new Set([1044, 1045, 1049, 1054, 1142, 1146]);
const mysqlRetryable = new Set([1040, 1053, 1205, 1213, 1290, 1836, 2002, 2003, 2006, 2013]);
const nodeRetryable = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN']);
const chunkFinal = new Set<FailureCode>(['config', 'record', 'parse', 'lock', 'interrupted']);

// A second ENOSPC in the process means the reservation math is wrong for this box, not a transient blip.
let enospcSeen = 0;

const cls = (code: FailureCode, retriable: boolean, chunkRetriable: boolean, fatal: boolean, aborted = false): ErrorClass =>
  ({ code, retriable, chunkRetriable, fatal, aborted });

const isAbort = (err: unknown): boolean =>
  (err instanceof Error && err.name === 'AbortError') || (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError');
const field = (err: unknown, name: string): unknown => (typeof err === 'object' && err !== null ? (err as Record<string, unknown>)[name] : undefined);
const httpStatus = (err: unknown): number | undefined => {
  const meta = field(err, '$metadata');
  return typeof meta === 'object' && meta !== null ? (meta as { httpStatusCode?: number }).httpStatusCode : undefined;
};

/** Decides whether an error retries the operation, retries the chunk, or ends the run. */
export default function classifyError(err: unknown): ErrorClass {
  if (isMsmError(err)) {
    if (err.msmCode === 'interrupted') return cls('interrupted', false, false, false, true);
    return cls(err.msmCode, err.retriable ?? err.msmCode === 'insert_race', !chunkFinal.has(err.msmCode), err.fatal);
  }
  if (isAbort(err)) return cls('interrupted', false, false, false, true);

  if (err instanceof MongoCompatibilityError) return cls('config', false, false, true);
  if (err instanceof MongoNetworkError || err instanceof MongoServerSelectionError) return cls('mongo', true, true, false);
  if (err instanceof MongoError) {
    const code = typeof err.code === 'number' ? err.code : Number(err.code);
    if (mongoFatal.has(code)) return cls('mongo', false, false, true);
    if (code === 50) return cls('mongo', false, true, false);
    if (err.hasErrorLabel('RetryableError') || err.hasErrorLabel('ResetPool') || mongoRetryable.has(code)) return cls('mongo', true, true, false);
    if (/not master|not writable primary|node is recovering/i.test(err.message)) return cls('mongo', true, true, false);
    return cls('mongo', false, true, false);
  }

  const name = field(err, 'name');
  const status = httpStatus(err);
  const isS3 = status !== undefined || (typeof name === 'string' && (s3Fatal.has(name) || s3Retryable.has(name)));
  if (isS3) {
    // A 401 or 403 is a permission problem whatever the SDK named it (a HEAD response has no body, so it reads `Unknown`).
    if (status === 401 || status === 403) return cls('s3', false, false, true);
    if (typeof name === 'string' && s3Fatal.has(name)) return cls('s3', false, false, true);
    const retryable = (status !== undefined && (status >= 500 || status === 429))
      || (typeof name === 'string' && s3Retryable.has(name)) || field(err, '$retryable') !== undefined;
    return cls('s3', retryable, true, false);
  }

  const errno = field(err, 'errno');
  const code = field(err, 'code');
  if (typeof errno === 'number' && (field(err, 'sqlState') !== undefined || field(err, 'sqlMessage') !== undefined || mysqlFatal.has(errno) || mysqlRetryable.has(errno))) {
    if (mysqlFatal.has(errno)) return cls('mysql', false, false, true);
    if (mysqlRetryable.has(errno)) return cls('mysql', true, true, false);
    return cls('mysql', false, true, false);
  }
  if (code === 'PROTOCOL_CONNECTION_LOST') return cls('mysql', true, true, false);
  // mysql2 marks a connection it closed itself (a query on a closed socket) with `fatal: true` and no SQL state.
  if (field(err, 'fatal') === true && field(err, 'sqlState') === undefined && typeof code !== 'string') return cls('mysql', true, true, false);
  if (typeof code === 'string' && nodeRetryable.has(code)) return cls('unknown', true, true, false);

  if (code === 'ENOSPC') {
    enospcSeen += 1;
    return enospcSeen === 1 ? cls('disk', false, true, false) : cls('disk', false, false, true);
  }
  return cls('unknown', false, true, false);
}
