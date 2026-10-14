import { describe, expect, it } from 'vitest';
import sampleDocs from '#infer/sampleDocs';
import listChunkManifests from '#layout/listChunkManifests';
import type { ResolvedManifest } from '#types';
import { memoryContext } from '../../helpers.js';
import seedChunks, { fixtureDocs, window } from './seedChunks.js';

const line = (n: number, extra = ''): string =>
  `{"_id":{"$oid":"${n.toString(16).padStart(24, '0')}"},"n":{"$numberInt":"${n}"}${extra}}`;

const numbers = (docs: { n?: unknown }[]) =>
  docs.map(d => Number((d.n as { $numberInt: string }).$numberInt));

async function archive(partSizes: number[], batchId = 'b-full-20261013T000000Z') {
  const env = memoryContext({ command: 'infer' });
  const seed = seedChunks(env.store, env.layout);
  let next = 1;

  for (const [i, size] of partSizes.entries()) {
    const lines = Array.from({ length: size }, () => line(next++));

    await seed.chunk({ collection: 'c', batchId, lines, window: window(`2026-03-0${i + 1}`) });
  }

  const manifests = await listChunkManifests(env.store, env.layout, 'c', batchId);

  return { ...env, manifests };
}

describe('sampleDocs', () => {
  it('reads every line when the sample size covers the archive', async () => {
    const { ctx, store, manifests } = await archive([5, 5, 5]);
    const docs = await sampleDocs(ctx, store, manifests, { sampleSize: 100, maxParts: 50 });

    expect(numbers(docs)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('spreads the chosen parts evenly over the list: round(i * (n - 1) / (k - 1))', async () => {
    const { ctx, store, manifests } = await archive([1, 1, 1, 1, 1, 1, 1]);
    const docs = await sampleDocs(ctx, store, manifests, { sampleSize: 100, maxParts: 3 });

    expect(numbers(docs)).toEqual([1, 4, 7]);

    const one = await sampleDocs(ctx, store, manifests, { sampleSize: 100, maxParts: 1 });

    expect(numbers(one)).toEqual([1]);

    const two = await sampleDocs(ctx, store, manifests, { sampleSize: 100, maxParts: 2 });

    expect(numbers(two)).toEqual([1, 7]);
  });

  it('keeps every k-th line across the chosen parts and stops at the sample size', async () => {
    const { ctx, store, manifests } = await archive([10, 10]);
    const docs = await sampleDocs(ctx, store, manifests, { sampleSize: 5, maxParts: 50 });

    expect(numbers(docs)).toEqual([1, 5, 9, 13, 17]);

    // The stride rounds up (20 / 3 -> 7), so the sample stays within sampleSize and reaches the
    // last part.
    const capped = await sampleDocs(ctx, store, manifests, { sampleSize: 3, maxParts: 50 });

    expect(numbers(capped)).toEqual([1, 8, 15]);

    const odd = await archive([5, 5, 5]);

    expect(
      numbers(await sampleDocs(odd.ctx, odd.store, odd.manifests, { sampleSize: 4, maxParts: 50 }))
    ).toEqual([1, 5, 9, 13]);
  });

  it('uses the exported count for single-part chunks, else the part line counts', async () => {
    const env = memoryContext({ command: 'infer' });
    const seed = seedChunks(env.store, env.layout);

    await seed.chunk({
      collection: 'c',
      batchId: 'b',
      lines: Array.from({ length: 6 }, (_, i) => line(i + 1)),
      partSize: 2,
    });

    const manifests = await listChunkManifests(env.store, env.layout, 'c', 'b');

    expect(manifests[0]?.parts.map(p => p.lines)).toEqual([2, 2, 2]);

    const docs = await sampleDocs(env.ctx, env.store, manifests, { sampleSize: 3, maxParts: 50 });

    expect(numbers(docs)).toEqual([1, 3, 5]);
  });

  it('returns nothing for manifest-only chunks', async () => {
    const env = memoryContext({ command: 'infer' });

    await seedChunks(env.store, env.layout).chunk({
      collection: 'c',
      batchId: 'b',
      lines: [],
      mode: 'manifest-only',
    });

    const manifests = await listChunkManifests(env.store, env.layout, 'c', 'b');

    expect(manifests).toHaveLength(1);

    expect(
      await sampleDocs(env.ctx, env.store, manifests, { sampleSize: 10, maxParts: 10 })
    ).toEqual([]);
  });

  it('skips non-document lines with one warning and fails on a missing part', async () => {
    const env = memoryContext({ command: 'infer' });
    const seed = seedChunks(env.store, env.layout);

    await seed.chunk({
      collection: 'c',
      batchId: 'b',
      lines: [line(1), 'not json', '[1,2]', line(2)],
    });

    const manifests = await listChunkManifests(env.store, env.layout, 'c', 'b');
    const docs = await sampleDocs(env.ctx, env.store, manifests, { sampleSize: 10, maxParts: 10 });

    expect(numbers(docs)).toEqual([1, 2]);

    expect(
      env.events.filter(e => e.type === 'warn').map(e => (e as { message: string }).message)
    ).toEqual(['c: 2 sampled lines are not JSON documents; run verify']);

    const gone: ResolvedManifest[] = manifests.map(m => ({
      ...m,
      parts: m.parts.map(p => ({ ...p, key: `${p.key}.missing` })),
    }));

    await expect(
      sampleDocs(env.ctx, env.store, gone, { sampleSize: 10, maxParts: 10 })
    ).rejects.toMatchObject({ msmCode: 's3' });
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    const env = memoryContext({ command: 'infer', signal: controller.signal });

    await seedChunks(env.store, env.layout).chunk({
      collection: 'c',
      batchId: 'b',
      lines: [line(1), line(2)],
    });

    const manifests = await listChunkManifests(env.store, env.layout, 'c', 'b');

    controller.abort('SIGINT');

    await expect(
      sampleDocs(env.ctx, env.store, manifests, { sampleSize: 10, maxParts: 10 })
    ).rejects.toMatchObject({ msmCode: 'interrupted' });
  });

  it('parses the orders fixture with wrappers intact', async () => {
    const env = memoryContext({ command: 'infer' });
    const lines = (await fixtureDocs('orders')).map(d => JSON.stringify(d));

    await seedChunks(env.store, env.layout).chunk({
      collection: 'orders',
      batchId: 'b',
      lines,
      partSize: 25,
    });

    const manifests = await listChunkManifests(env.store, env.layout, 'orders', 'b');

    const docs = await sampleDocs(env.ctx, env.store, manifests, {
      sampleSize: 10_000,
      maxParts: 50,
    });

    expect(docs).toHaveLength(60);
    expect(docs[0]?.total).toEqual({ $numberDecimal: '10.00' });
    expect(docs[7]?._id).toBe('legacy-7');
  });
});
