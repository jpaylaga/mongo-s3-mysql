import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import idleWatchdog from '../../../src/s3/idleWatchdog.js';

describe('idleWatchdog', () => {
  afterEach(() => vi.useRealTimers());

  it('passes the bytes through and ends cleanly when the source ends', async () => {
    const out = idleWatchdog(Readable.from([Buffer.from('ab'), Buffer.from('c')]), 1000, 'k');
    expect(await text(out)).toBe('abc');
  });

  it('destroys both streams with a TimeoutError once no byte arrives for the limit, refreshed by every chunk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const source = new Readable({ read() {} });
    const out = idleWatchdog(source, 1000, 'raw/part.gz');
    const chunks: string[] = [];
    out.on('data', (c: Buffer) => chunks.push(c.toString()));
    const failed = new Promise<Error>((resolve) => { out.on('error', resolve); });
    source.push(Buffer.from('a'));
    await vi.advanceTimersByTimeAsync(900);
    source.push(Buffer.from('b'));
    await vi.advanceTimersByTimeAsync(900);
    expect(source.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const err = await failed;
    expect(err).toMatchObject({ name: 'TimeoutError', message: 'raw/part.gz: S3 body idle for 1000 ms' });
    expect(source.destroyed).toBe(true);
    expect(chunks.join('')).toBe('ab');
  });

  it('forwards a source error and stops the timer', async () => {
    const source = new Readable({ read() { this.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' })); } });
    await expect(text(idleWatchdog(source, 1000, 'k'))).rejects.toMatchObject({ code: 'ECONNRESET' });
  });
});
