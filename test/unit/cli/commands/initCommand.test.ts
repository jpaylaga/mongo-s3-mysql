import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import initCommand from '../../../../src/cli/commands/initCommand.js';
import parseConfig from '../../../../src/config/parseConfig.js';
import { tmpDir } from '../../../helpers.js';

const quiet = { writeErr: () => {}, writeOut: () => {} };
const program = (config: string) => new Command().name('mongo-s3-mysql').exitOverride().configureOutput(quiet)
  .option('-c, --config <path>', 'config file', config).option('--json')
  .addCommand(initCommand().exitOverride().configureOutput(quiet));

describe('initCommand', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes the example config with an empty collections list, so inventory --write-config runs without --force', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
    const path = join(await tmpDir(), 'mongo-s3-mysql.config.json');
    await program(path).parseAsync(['node', 'cli', 'init']);
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(written.collections).toEqual([]);
    expect(written.s3).toMatchObject({ bucket: 'example-archive-bucket', prefix: 'mongo-archive' });
    expect(parseConfig(written, '/work').collections).toEqual([]);
    // The example's CA bundle is a file the user does not have; without it load would fail with ENOENT before connecting.
    expect(written.mysql).toEqual({ host: 'mysql.example.internal', user: 'archive_loader', database: 'archive' });
    expect(await readFile(path, 'utf8')).toMatch(/\n$/);
    expect(out.join('')).toContain(`next: edit mongo, s3 and mysql in ${path}, set MSM_MONGO_URI, then run: mongo-s3-mysql inventory --write-config`);
  });

  it('refuses to overwrite an existing file unless --force', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const path = join(await tmpDir(), 'mongo-s3-mysql.config.json');
    await program(path).parseAsync(['node', 'cli', 'init']);
    await expect(program(path).parseAsync(['node', 'cli', 'init'])).rejects.toThrow(`${path} already exists; pass --force to overwrite it`);
    await program(path).parseAsync(['node', 'cli', 'init', '--force']);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ collections: [] });
  });

  it('rejects an unknown option', async () => {
    await expect(program('/nonexistent/x.json').parseAsync(['node', 'cli', 'init', '--deep'])).rejects.toThrow(/unknown option/);
  });
});
