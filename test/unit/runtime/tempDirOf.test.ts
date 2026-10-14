import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import tempDirOf from '../../../src/runtime/tempDirOf.js';

describe('tempDirOf', () => {
  it('nests the area under a hash of the state directory, below tempDir or the stateDir/tmp fallback', () => {
    const configured = tempDirOf({ stateDir: '/var/lib/msm', tempDir: '/scratch' }, 'export');
    expect(configured).toMatch(/^\/scratch\/[0-9a-f]{12}\/export$/);
    const fallback = tempDirOf({ stateDir: '/var/lib/msm', tempDir: undefined }, 'load');
    expect(fallback).toMatch(/^\/var\/lib\/msm\/tmp\/[0-9a-f]{12}\/load$/);
    // The owner segment depends only on the resolved state directory, so a shared tempDir separates two state directories.
    const owner = (dir: string) => tempDirOf({ stateDir: dir, tempDir: '/scratch' }, 'reconcile').split('/')[2];
    expect(owner('/var/lib/msm')).toBe(owner('/var/lib/../lib/msm'));
    expect(owner('/var/lib/msm')).not.toBe(owner('/var/lib/other'));
    expect(configured).toBe(join('/scratch', owner(resolve('/var/lib/msm')) as string, 'export'));
  });
});
