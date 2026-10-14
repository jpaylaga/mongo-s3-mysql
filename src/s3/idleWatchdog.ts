import { PassThrough, pipeline, type Readable } from 'node:stream';

/**
 * A body stream that fails when no byte arrives for `ms`. The SDK's own socket timeout is armed after the
 * request starts and cleared once the response headers are in, so a body that stalls after the headers (a
 * half-open connection) would otherwise hang its reader until TCP keepalive gives the path up, about two hours
 * on a default Linux host. The error is named `TimeoutError`, which the retry classifier already treats as transient.
 */
export default function idleWatchdog(body: Readable, ms: number, key: string): Readable {
  const out = new PassThrough();
  const fire = () => {
    const err = Object.assign(new Error(`${key}: S3 body idle for ${ms} ms`), { name: 'TimeoutError' });
    body.destroy(err);
    out.destroy(err);
  };
  const timer = setTimeout(fire, ms);
  timer.unref();
  body.on('data', () => timer.refresh());
  pipeline(body, out, () => clearTimeout(timer));
  return out;
}
