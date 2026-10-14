import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import resolveMappingPath from '#mapping/resolveMappingPath';
import { exampleConfig, memoryContext, tmpDir } from '../../helpers.js';

describe('resolveMappingPath', () => {
  it('returns the configured or default path; warns and skips an absent default', async () => {
    const dir = await tmpDir();
    const mappingsDir = join(dir, 'mappings');

    await mkdir(mappingsDir);
    await writeFile(join(mappingsDir, 'orders.mapping.json'), '{}');
    await writeFile(join(dir, 'curated.json'), '{}');

    const { ctx, events } = memoryContext({
      command: 'load',
      config: exampleConfig({ mappingsDir }, dir),
    });

    expect(await resolveMappingPath(ctx, { name: 'orders', window: 'day', rest: 'auto' })).toBe(
      join(mappingsDir, 'orders.mapping.json')
    );

    expect(
      await resolveMappingPath(ctx, {
        name: 'orders',
        window: 'day',
        rest: 'auto',
        mapping: join(dir, 'curated.json'),
      })
    ).toBe(join(dir, 'curated.json'));

    expect(
      await resolveMappingPath(ctx, { name: 'coupons', window: 'day', rest: 'auto' })
    ).toBeNull();

    expect(events).toEqual([
      {
        type: 'warn',
        command: 'load',
        message:
          `coupons: no mapping at ${join(mappingsDir, 'coupons.mapping.json')}; ` +
          'skipped (run infer first)',
      },
    ]);
  });

  it('a missing configured path is fatal, and so is an absent default under -C', async () => {
    const dir = await tmpDir();

    const { ctx } = memoryContext({
      command: 'reconcile',
      config: exampleConfig({ mappingsDir: join(dir, 'mappings') }, dir),
    });

    await expect(
      resolveMappingPath(ctx, {
        name: 'orders',
        window: 'day',
        rest: 'auto',
        mapping: join(dir, 'nope.json'),
      })
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message: `orders: configured mapping ${join(dir, 'nope.json')} does not exist`,
    });

    await expect(
      resolveMappingPath(ctx, { name: 'orderz', window: 'day', rest: 'auto' }, true)
    ).rejects.toMatchObject({
      msmCode: 'config',
      fatal: true,
      message:
        `-C orderz: no mapping at ${join(dir, 'mappings', 'orderz.mapping.json')}; ` +
        'run infer first, or check the name',
    });
  });
});
