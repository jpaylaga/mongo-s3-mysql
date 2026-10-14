import { afterEach, describe, expect, it, vi } from 'vitest';
import msmError from '#runtime/msmError';
import withRetry from '#runtime/withRetry';
import { memoryContext } from '../../helpers.js';

const transient = () =>
  Object.assign(new Error('SlowDown'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } });

describe('withRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries retriable errors up to retry.attempts and emits a retry event per wait', async () => {
    const { ctx, events } = memoryContext();
    let calls = 0;

    const result = await withRetry(ctx, { source: 's3', name: 'putText' }, async attempt => {
      calls += 1;

      if (attempt < 3) throw transient();

      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls).toBe(3);

    const retries = events.filter(e => e.type === 'retry');

    expect(retries).toHaveLength(2);

    expect(retries[0]).toMatchObject({
      source: 's3',
      name: 'putText',
      attempt: 1,
      error: 'SlowDown',
    });
  });

  it('gives up after the last attempt with the original error', async () => {
    const { ctx } = memoryContext();

    await expect(
      withRetry(ctx, { source: 's3', name: 'x' }, async () => {
        throw transient();
      })
    ).rejects.toThrow('SlowDown');
  });

  it('does not retry non-retriable or fatal errors', async () => {
    const { ctx, events } = memoryContext();
    let calls = 0;

    await expect(
      withRetry(ctx, { source: 'mysql', name: 'x' }, async () => {
        calls += 1;

        throw msmError('record', 'bad');
      })
    ).rejects.toThrow('bad');

    await expect(
      withRetry(ctx, { source: 'mysql', name: 'x' }, async () => {
        calls += 1;

        throw msmError('s3', 'denied', { retriable: true, fatal: true });
      })
    ).rejects.toThrow('denied');

    expect(calls).toBe(2);
    expect(events).toHaveLength(0);
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const { ctx } = memoryContext({ signal: controller.signal, config: memoryContext().config });

    ctx.config.retry.baseDelayMs = 50;
    ctx.config.retry.maxDelayMs = 50;
    // Full jitter may pick a wait near zero, which would let a second attempt run before the abort
    // lands.
    vi.spyOn(Math, 'random').mockReturnValue(1);

    let calls = 0;

    const run = withRetry(ctx, { source: 's3', name: 'x' }, async () => {
      calls += 1;

      throw transient();
    });

    setTimeout(() => controller.abort('SIGINT'), 5);
    await expect(run).rejects.toMatchObject({ msmCode: 'interrupted' });
    expect(calls).toBe(1);

    await expect(withRetry(ctx, { source: 's3', name: 'x' }, async () => 1)).rejects.toMatchObject({
      msmCode: 'interrupted',
    });
  });

  it('redacts secrets in the retry event', async () => {
    const { ctx, events } = memoryContext();

    await withRetry(ctx, { source: 'mongo', name: 'count' }, async attempt => {
      if (attempt === 1)
        throw Object.assign(new Error('mongodb://admin:hunter2@h/db reset'), {
          code: 'ECONNRESET',
        });

      return 1;
    });

    const retry = events.find(e => e.type === 'retry');

    expect(retry && 'error' in retry ? retry.error : '').not.toContain('hunter2');
  });
});
