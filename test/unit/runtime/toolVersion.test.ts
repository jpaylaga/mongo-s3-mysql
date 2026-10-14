import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import toolVersion from '../../../src/runtime/toolVersion.js';

describe('toolVersion', () => {
  it('is <name>@<version> from package.json, the value every record carries as `tool`', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
    expect(toolVersion).toBe(`${pkg.name}@${pkg.version}`);
    expect(toolVersion).toMatch(/^mongo-s3-mysql@\d+\.\d+\.\d+/);
  });
});
