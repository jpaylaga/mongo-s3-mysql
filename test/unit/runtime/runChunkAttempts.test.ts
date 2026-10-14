import { describe, expect, it } from 'vitest';
import msmError from '#runtime/msmError';
import runChunkAttempts from '#runtime/runChunkAttempts';
import type { ChunkOutcome } from '#types';
import { memoryContext } from '../../helpers.js';

const chunk = { chunk: 'b-c-full-collection-full', collection: 'c' };
const done = (): ChunkOutcome => ({ ...chunk, status: 'done', docs: 3 });

describe('runChunkAttempts', () => {
  it('returns the outcome of a successful attempt', async () => {
    const { ctx } = memoryContext();

    expect(await runChunkAttempts(ctx, chunk, 3, async () => done())).toMatchObject({
      status: 'done',
      docs: 3,
    });
  });

  it('retries the chunk on chunk-retriable errors and emits a retry chunk event', async () => {
    const { ctx, events } = memoryContext();
    let calls = 0;

    const out = await runChunkAttempts(ctx, chunk, 3, async attempt => {
      calls += 1;

      if (attempt < 2) throw msmError('count_mismatch', 'before 1, after 2, exported 1');

      return done();
    });

    expect(out.status).toBe('done');
    expect(calls).toBe(2);

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'chunk', chunk: chunk.chunk, status: 'retry' })
    );
  });

  it('fails after the last attempt with the code and a redacted message', async () => {
    const { ctx } = memoryContext();

    const out = await runChunkAttempts(ctx, chunk, 2, async () => {
      throw new Error('mongodb://u:hunter2@h failed');
    });

    expect(out).toMatchObject({ status: 'failed', code: 'unknown' });
    expect(out.error).not.toContain('hunter2');
  });

  it('fails at once on errors that cannot retry the chunk', async () => {
    const { ctx } = memoryContext();
    let calls = 0;

    const out = await runChunkAttempts(ctx, chunk, 5, async () => {
      calls += 1;

      throw msmError('record', 'bad manifest');
    });

    expect(out).toMatchObject({ status: 'failed', code: 'record', error: 'bad manifest' });
    expect(calls).toBe(1);
  });

  it('rethrows fatal errors', async () => {
    const { ctx } = memoryContext();

    await expect(
      runChunkAttempts(ctx, chunk, 3, async () => {
        throw msmError('s3', 'AccessDenied', { fatal: true });
      })
    ).rejects.toThrow('AccessDenied');
  });

  it('reports interrupted when aborted before or during an attempt', async () => {
    const controller = new AbortController();
    const { ctx } = memoryContext({ signal: controller.signal });
    const abort = Object.assign(new Error('Upload aborted.'), { name: 'AbortError' });

    expect(
      await runChunkAttempts(ctx, chunk, 3, async () => {
        throw abort;
      })
    ).toMatchObject({ status: 'interrupted', code: 'interrupted' });

    controller.abort('SIGTERM');

    let calls = 0;

    expect(
      await runChunkAttempts(ctx, chunk, 3, async () => {
        calls += 1;

        return done();
      })
    ).toMatchObject({ status: 'interrupted' });

    expect(calls).toBe(0);
  });
});
